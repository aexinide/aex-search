// SPDX-License-Identifier: GPL-3.0-or-later
// Aex Search - https://github.com/aexinide/aex-search

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Lib from './lib.js';
import * as Colors from './colors.js';

const MODES = ['all', 'files', 'apps', 'content'];
const MODE_LABELS = {all: 'All', files: 'Files', apps: 'Apps', content: 'Content'};
const MODE_PLACEHOLDER = {
    all: 'Search apps, files and folders…',
    files: 'Search files and folders…',
    apps: 'Search applications…',
    content: 'Search inside files…',
};
const KEYBINDINGS = [
    ['shortcut-all', 'all'],
    ['shortcut-files', 'files'],
    ['shortcut-apps', 'apps'],
    ['shortcut-content', 'content'],
];
const HINTS = '↑↓ select   ⏎ open   ⇧⏎ show in folder   Ctrl+⏎ copy path   Tab switch mode   Esc close';
const decoder = new TextDecoder('utf-8');

function _which(name) {
    return GLib.find_program_in_path(name);
}

function _appItem(info) {
    return {
        kind: 'app',
        info,
        id: info.get_id() ?? '',
        name: info.get_name() ?? '',
        generic: info.get_generic_name?.() ?? '',
        keywords: (info.get_keywords?.() ?? []).join(' '),
        description: info.get_description() ?? '',
    };
}

class AexPopup {
    constructor(settings, openPrefs) {
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._isOpen = false;
        this._mode = 'all';
        this._token = 0;
        this._rows = [];
        this._items = [];
        this._sel = -1;
        this._selKey = null;
        this._pending = [];
        this._appCache = null;
        this._recentCache = null;
        this._proc = null;
        this._cancellable = null;
        this._infoCancellable = null;
        this._debounceId = 0;
        this._flushId = 0;
        this._renderId = 0;
        this._running = false;
        this._grab = null;
        this._pal = null;
    }

    get isOpen() {
        return this._isOpen;
    }

    toggle(mode) {
        if (this._isOpen && this._mode === mode)
            this.close();
        else if (this._isOpen)
            this.setMode(mode);
        else
            this.open(mode);
    }

    // ------------------------------------------------------------ lifecycle

    open(mode) {
        if (this._isOpen)
            return;
        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._mode = MODES.includes(mode) ? mode : 'all';
        this._appCache = null;
        this._recentCache = null;
        this._buildUi(monitor);

        Main.layoutManager.modalDialogGroup.add_child(this._backdrop);
        const grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if (!grab) {
            this._backdrop.destroy();
            this._backdrop = null;
            return;
        }
        if (typeof grab === 'object' && typeof grab.get_seat_state === 'function' &&
            grab.get_seat_state() === Clutter.GrabState.NONE) {
            Main.popModal(grab);
            this._backdrop.destroy();
            this._backdrop = null;
            return;
        }
        this._grab = grab;
        this._isOpen = true;

        if (this._settings.get_boolean('animations')) {
            this._backdrop.opacity = 0;
            this._backdrop.ease({
                opacity: 255,
                duration: 110,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._entry.grab_key_focus();
        this._refreshTabs();
        this._search();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._cancelSearch();
        this._clearDebounce();
        this._cancelRender();
        if (this._infoCancellable)
            this._infoCancellable.cancel();
        this._infoCancellable = null;

        try {
            Main.popModal(typeof this._grab === 'object' ? this._grab : this._backdrop);
        } catch (e) {
            console.error(`Aex Search: popModal failed: ${e}`);
        }
        this._grab = null;
        if (this._backdrop)
            this._backdrop.destroy();
        this._backdrop = null;
        this._card = null;
        this._entry = null;
        this._scroll = null;
        this._list = null;
        this._tabs = null;
        this._pal = null;
        this._rows = [];
        this._items = [];
        this._sel = -1;
        this._selKey = null;
    }

    destroy() {
        this.close();
        this._appCache = null;
        this._recentCache = null;
    }

    setMode(mode) {
        if (!MODES.includes(mode) || mode === this._mode)
            return;
        this._mode = mode;
        this._entry.hint_text = MODE_PLACEHOLDER[mode];
        this._refreshTabs();
        this._scheduleSearch(true);
    }

    _openSettings() {
        this.close();
        try {
            this._openPrefs?.();
        } catch (e) {
            console.error(`Aex Search: cannot open preferences: ${e}`);
        }
    }

    // ------------------------------------------------------------ theme

    // Returns {light, pal}. `pal` is only set for the custom theme and carries the
    // colors that the stylesheet cannot know about.
    _resolveTheme() {
        const theme = this._settings.get_string('theme');
        if (theme === 'custom') {
            const pal = Colors.buildPalette(
                this._settings.get_string('custom-bg'),
                this._settings.get_string('custom-accent'));
            return {light: pal.light, pal};
        }
        if (theme === 'light')
            return {light: true, pal: null};
        if (theme === 'dark')
            return {light: false, pal: null};
        try {
            const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            return {light: iface.get_string('color-scheme') !== 'prefer-dark', pal: null};
        } catch (_e) {
            return {light: false, pal: null};
        }
    }

    // Applies a custom-theme text tone (muted / faint) to an actor; no-op for built-in themes.
    _tone(actor, tone) {
        if (this._pal)
            actor.set_style(`color: ${this._pal[tone]};`);
        return actor;
    }

    // ------------------------------------------------------------ UI

    _buildUi(monitor) {
        const s = this._settings;
        const {light, pal} = this._resolveTheme();
        this._pal = pal;

        const width = Math.min(s.get_int('popup-width'), monitor.width - 40);
        const listHeight = Math.max(200, Math.min(480, Math.floor(monitor.height * 0.5)));

        this._backdrop = new St.Widget({
            style_class: 'aex-backdrop',
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        // Any press that lands outside the card closes the popup.
        this._backdrop.connect('captured-event', (_a, event) => this._onBackdropEvent(event));

        this._card = new St.BoxLayout({
            style_class: `aex-card${light ? ' aex-light' : ''}`,
            vertical: true,
            reactive: true,
            width,
        });
        if (pal)
            this._card.set_style(`background-color: ${pal.bg}; color: ${pal.text}; border-color: ${pal.border};`);
        this._card.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height * s.get_int('popup-top') / 100));
        this._backdrop.add_child(this._card);

        // Mode tabs + settings button (top right)
        const tabs = new St.BoxLayout({style_class: 'aex-tabs', x_expand: true});
        this._tabs = {};
        for (const mode of MODES) {
            const btn = new St.Button({
                style_class: 'aex-tab',
                label: MODE_LABELS[mode],
                can_focus: false,
                reactive: true,
            });
            btn.connect('clicked', () => this.setMode(mode));
            this._tabs[mode] = btn;
            tabs.add_child(btn);
        }
        tabs.add_child(new St.Widget({x_expand: true}));
        const gear = new St.Button({
            style_class: 'aex-icon-button',
            can_focus: false,
            reactive: true,
            accessible_name: 'Settings',
            y_align: Clutter.ActorAlign.CENTER,
        });
        gear.set_child(this._tone(new St.Icon({
            icon_name: 'preferences-system-symbolic',
            style_class: 'aex-icon-button-icon',
        }), 'muted'));
        gear.connect('clicked', () => this._openSettings());
        tabs.add_child(gear);
        this._card.add_child(tabs);

        // Entry
        this._entry = new St.Entry({
            style_class: 'aex-entry',
            hint_text: MODE_PLACEHOLDER[this._mode],
            can_focus: true,
            x_expand: true,
        });
        if (pal) {
            this._entry.set_style(
                `background-color: ${pal.soft}; color: ${pal.text}; caret-color: ${pal.text}; ` +
                `border-color: ${pal.border}; selection-background-color: ${pal.accent}; ` +
                `selected-color: ${pal.onAccent};`);
            this._entry.get_hint_actor?.()?.set_style(`color: ${pal.faint};`);
        }
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'aex-entry-icon',
        }));
        this._entry.clutter_text.connect('text-changed', () => this._scheduleSearch(false));
        this._entry.clutter_text.connect('key-press-event', (a, e) => this._onKey(a, e));
        this._card.add_child(this._entry);

        // Results
        this._list = new St.BoxLayout({style_class: 'aex-list', vertical: true, x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'aex-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            height: listHeight,
        });
        this._scroll.set_child(this._list);
        this._card.add_child(this._scroll);

        // Footer
        this._pathLabel = this._tone(new St.Label({style_class: 'aex-path-label', text: ' '}), 'muted');
        this._pathLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this._card.add_child(this._pathLabel);

        const foot = new St.BoxLayout({style_class: 'aex-footer'});
        this._statusLabel = this._tone(
            new St.Label({style_class: 'aex-status', x_expand: true, text: ''}), 'faint');
        this._statusLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        foot.add_child(this._statusLabel);
        this._card.add_child(foot);

        if (s.get_boolean('show-hints')) {
            const hint = this._tone(new St.Label({style_class: 'aex-hint', text: HINTS}), 'faint');
            hint.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._card.add_child(hint);
        }
    }

    _onBackdropEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (!this._card)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [cx, cy] = this._card.get_transformed_position();
        const [cw, ch] = this._card.get_transformed_size();
        if (x >= cx && x <= cx + cw && y >= cy && y <= cy + ch)
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _refreshTabs() {
        const pal = this._pal;
        for (const mode of MODES) {
            const tab = this._tabs[mode];
            const active = mode === this._mode;
            // A style class, not the 'active' pseudo-class: St.Button resets that one
            // itself every time it is clicked, which made the highlight vanish.
            if (active)
                tab.add_style_class_name('aex-tab-active');
            else
                tab.remove_style_class_name('aex-tab-active');
            if (pal) {
                tab.set_style(active
                    ? `color: ${pal.onAccent}; background-color: ${pal.accent};`
                    : `color: ${pal.muted};`);
            }
        }
    }

    _vadj() {
        const s = this._scroll;
        return s.vadjustment ?? s.vscroll?.adjustment ??
            s.get_vscroll_bar?.()?.get_adjustment?.() ?? null;
    }

    _ensureVisible(row) {
        const adj = this._vadj();
        if (!adj)
            return;
        const box = row.get_allocation_box();
        const y1 = box.y1;
        const y2 = box.y2;
        if (y1 < adj.value)
            adj.value = y1;
        else if (y2 > adj.value + adj.page_size)
            adj.value = y2 - adj.page_size;
    }

    // ------------------------------------------------------------ keyboard

    _onKey(_actor, event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;

        switch (sym) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._move(8);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._move(-8);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activateSelected({shift, ctrl});
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
            this._cycleMode(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            this._cycleMode(-1);
            return Clutter.EVENT_STOP;
        default:
            break;
        }

        if (ctrl && sym === Clutter.KEY_comma) {
            this._openSettings();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_n || sym === Clutter.KEY_N)) {
            this._move(1);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_p || sym === Clutter.KEY_P)) {
            this._move(-1);
            return Clutter.EVENT_STOP;
        }
        if (alt && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_4) {
            this.setMode(MODES[sym - Clutter.KEY_1]);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _cycleMode(dir) {
        const i = MODES.indexOf(this._mode);
        this.setMode(MODES[(i + dir + MODES.length) % MODES.length]);
    }

    _move(delta) {
        const n = this._rows.length;
        if (!n)
            return;
        let i = this._sel + delta;
        if (Math.abs(delta) === 1)
            i = (i + n) % n;
        else
            i = Math.max(0, Math.min(n - 1, i));
        this._select(i);
    }

    _itemKey(item) {
        return item.kind === 'app' ? `app:${item.id}` : `${item.kind}:${item.path}:${item.line ?? ''}`;
    }

    _select(index) {
        if (this._sel >= 0 && this._rows[this._sel]) {
            const prev = this._rows[this._sel];
            prev.remove_style_pseudo_class('selected');
            if (this._pal)
                prev.set_style(null);
        }
        this._sel = index;
        const row = this._rows[index];
        const item = this._items[index];
        if (!row || !item) {
            this._selKey = null;
            this._pathLabel.text = ' ';
            return;
        }
        row.add_style_pseudo_class('selected');
        if (this._pal)
            row.set_style(`background-color: ${this._pal.selected};`);
        this._selKey = this._itemKey(item);
        this._pathLabel.text = item.kind === 'app'
            ? (item.info.get_filename?.() ?? item.id)
            : item.path;
        this._ensureVisible(row);
    }

    // ------------------------------------------------------------ search orchestration

    _clearDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    _scheduleSearch(immediate) {
        this._clearDebounce();
        const delay = immediate ? 0 : this._settings.get_int('debounce-ms');
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._debounceId = 0;
            this._search();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearch() {
        this._token++;
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = null;
        this._killProc();
        this._clearFlush();
        this._running = false;
    }

    _killProc() {
        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch (_e) {
                // already gone
            }
            this._proc = null;
        }
    }

    _clearFlush() {
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = 0;
        }
    }

    _scheduleFlush() {
        this._clearFlush();
        this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._flushId = 0;
            if (this._running && this._isOpen) {
                this._publish(false);
                this._scheduleFlush();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _search() {
        if (!this._isOpen)
            return;
        this._cancelSearch();
        const token = this._token;
        const s = this._settings;
        const cs = s.get_boolean('case-sensitive');
        const query = this._entry.get_text().trim();

        this._selKey = null;
        this._appItems = [];
        this._fileItems = [];
        this._contentItems = [];
        this._truncated = false;
        this._toolName = '';
        this._toolNote = '';
        this._cs = cs;
        this._roots = this._getRoots();
        this._words = this._mode === 'content'
            ? (query ? [cs ? query : Lib.fold(query)] : [])
            : Lib.splitQuery(query, cs);

        if (!query) {
            this._showEmpty();
            return;
        }

        if (this._mode === 'content') {
            if (query.length < 2) {
                this._showMessage('Type at least 2 characters to search inside files.');
                this._statusLabel.text = '';
                return;
            }
            this._searchContent(query, token);
            return;
        }

        if (this._mode === 'all' || this._mode === 'apps')
            this._appItems = this._searchApps(this._mode === 'apps' ? 200 : s.get_int('apps-in-all'));
        if (this._mode === 'apps') {
            this._publish(true);
            return;
        }
        this._searchFiles(token);
    }

    _getRoots() {
        const dirs = this._settings.get_strv('search-dirs')
            .filter(d => d && GLib.file_test(d, GLib.FileTest.IS_DIR))
            .map(d => Lib.stripSlash(d));
        return dirs.length ? dirs : [GLib.get_home_dir()];
    }

    // ------------------------------------------------------------ apps

    _allApps() {
        if (this._appCache)
            return this._appCache;
        const seen = new Set();
        const out = [];
        try {
            for (const info of Shell.AppSystem.get_default().get_installed()) {
                if (!info.should_show())
                    continue;
                const id = info.get_id();
                if (!id || seen.has(id))
                    continue;
                seen.add(id);
                out.push(_appItem(info));
            }
        } catch (e) {
            console.error(`Aex Search: listing applications failed: ${e}`);
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        this._appCache = out;
        return out;
    }

    _searchApps(limit) {
        const scored = [];
        for (const app of this._allApps()) {
            const score = Lib.scoreApp(app, this._words);
            if (score >= 0)
                scored.push({app, score});
        }
        scored.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name));
        return scored.slice(0, limit).map(x => x.app);
    }

    _frequentApps(n) {
        if (n <= 0)
            return [];
        try {
            const out = [];
            for (const app of Shell.AppUsage.get_default().get_most_used()) {
                const info = app.get_app_info?.();
                if (info && info.should_show())
                    out.push(_appItem(info));
                if (out.length >= n)
                    break;
            }
            return out;
        } catch (_e) {
            return [];
        }
    }

    // ------------------------------------------------------------ recent files

    _recentFiles(n) {
        if (n <= 0)
            return [];
        if (!this._recentCache) {
            this._recentCache = [];
            try {
                const file = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
                const [ok, data] = GLib.file_get_contents(file);
                if (ok) {
                    this._recentCache = Lib.parseRecent(decoder.decode(data), 80)
                        .filter(p => GLib.file_test(p, GLib.FileTest.EXISTS))
                        .map(path => ({kind: 'file', path, rel: 0}));
                }
            } catch (_e) {
                // no recent files available
            }
        }
        return this._recentCache.slice(0, n);
    }

    // Empty search box: one flat list, no section headings.
    _showEmpty() {
        const s = this._settings;
        const mode = this._mode;
        if (mode === 'content') {
            this._showMessage('Type to search inside the text of your files.');
            this._statusLabel.text = '';
            return;
        }
        let list = [];
        if (mode === 'apps') {
            list = this._allApps().slice(0, 300);
        } else {
            if (mode === 'all')
                list.push(...this._frequentApps(s.get_int('frequent-count')));
            list.push(...this._recentFiles(s.get_int('recent-count')));
        }
        if (!list.length) {
            this._showMessage('Start typing to search.');
            this._statusLabel.text = '';
            return;
        }
        this._renderList(list);
        this._statusLabel.text = '';
    }

    // ------------------------------------------------------------ file name search

    _pickFileTool() {
        const pref = this._settings.get_string('search-tool');
        const fd = _which('fd') || _which('fdfind');
        const find = _which('find');
        const plocate = _which('plocate');
        if (pref === 'plocate' && plocate)
            return {kind: 'plocate', bin: plocate};
        if (pref === 'find' && find)
            return {kind: 'find', bin: find};
        if (fd)
            return {kind: 'fd', bin: fd};
        if (find) {
            this._toolNote = 'fd not found – using slower find (sudo apt install fd-find)';
            return {kind: 'find', bin: find};
        }
        return null;
    }

    _searchFiles(token) {
        const s = this._settings;
        const cs = this._cs;
        const roots = this._roots;
        const excludes = s.get_strv('exclude-names');
        const showHidden = s.get_boolean('show-hidden');
        const includeDirs = s.get_boolean('include-folders');
        const limit = s.get_int('max-results');
        const cap = Math.min(limit * 3, 6000);
        const words = this._words;

        const tool = this._pickFileTool();
        if (!tool) {
            this._toolNote = 'No file search tool found (sudo apt install fd-find)';
            this._publish(true);
            return;
        }
        this._toolName = tool.kind;

        const opts = {words, roots, excludes, showHidden, cs, includeDirs};
        let argv;
        if (tool.kind === 'fd')
            argv = Lib.buildFdArgs(tool.bin, opts);
        else if (tool.kind === 'plocate')
            argv = Lib.buildPlocateArgs(tool.bin, opts);
        else
            argv = Lib.buildFindArgs(tool.bin, opts);

        const excluder = Lib.makeExcluder(excludes);
        const seen = new Set();
        this._running = true;
        this._scheduleFlush();

        this._spawnLines(argv, token, lines => {
            for (const raw of lines) {
                const path = Lib.stripSlash(raw);
                if (!path.startsWith('/') || seen.has(path))
                    continue;
                const rel = Lib.relStart(path, roots);
                if (!Lib.matchesAll(path.slice(rel), words, cs))
                    continue;
                if (Lib.isFiltered(path, roots, excluder, showHidden))
                    continue;
                seen.add(path);
                this._fileItems.push({kind: 'file', path, rel});
                if (this._fileItems.length >= cap)
                    return false;
            }
            return true;
        }, (ok, _err, stopped) => {
            this._running = false;
            this._truncated = stopped || this._fileItems.length > limit;
            this._clearFlush();
            this._publish(true);
        });
    }

    // ------------------------------------------------------------ content search

    _pickContentTool() {
        const pref = this._settings.get_string('content-tool');
        const rg = _which('rg');
        const grep = _which('grep');
        if (pref === 'grep' && grep)
            return {kind: 'grep', bin: grep};
        if (rg)
            return {kind: 'rg', bin: rg};
        if (grep) {
            this._toolNote = 'ripgrep not found – using slower grep (sudo apt install ripgrep)';
            return {kind: 'grep', bin: grep};
        }
        return null;
    }

    _searchContent(query, token) {
        const s = this._settings;
        const limit = s.get_int('max-results');
        const tool = this._pickContentTool();
        if (!tool) {
            this._toolNote = 'No content search tool found (sudo apt install ripgrep)';
            this._publish(true);
            return;
        }
        this._toolName = tool.kind;
        const opts = {
            query,
            roots: this._roots,
            excludes: s.get_strv('exclude-names'),
            showHidden: s.get_boolean('show-hidden'),
            cs: this._cs,
            regex: s.get_boolean('content-regex'),
            maxSizeMb: s.get_int('content-max-size-mb'),
        };
        const argv = tool.kind === 'rg' ? Lib.buildRgArgs(tool.bin, opts) : Lib.buildGrepArgs(tool.bin, opts);
        this._running = true;
        this._scheduleFlush();
        this._spawnLines(argv, token, lines => {
            for (const line of lines) {
                const m = Lib.parseGrepLine(line);
                if (!m)
                    continue;
                this._contentItems.push({kind: 'content', path: m.path, line: m.line, text: m.text, rel: 0});
                if (this._contentItems.length >= limit)
                    return false;
            }
            return true;
        }, (ok, _err, stopped) => {
            this._running = false;
            this._truncated = stopped;
            this._clearFlush();
            this._publish(true);
        });
    }

    // ------------------------------------------------------------ subprocess helper

    // onLines(lines) -> false to stop early. onDone(ok, error, stoppedEarly).
    _spawnLines(argv, token, onLines, onDone) {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`Aex Search: cannot run ${argv[0]}: ${e}`);
            onDone(false, e, false);
            return;
        }
        this._proc = proc;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const splitter = new Lib.LineSplitter(b => decoder.decode(b));
        const stream = proc.get_stdout_pipe();

        const readNext = () => {
            stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
                if (token !== this._token)
                    return;
                let data;
                try {
                    data = src.read_bytes_finish(res).get_data();
                } catch (e) {
                    onDone(false, e, false);
                    return;
                }
                if (!data || data.length === 0) {
                    const rest = splitter.finish();
                    if (rest.length)
                        onLines(rest);
                    this._proc = null;
                    onDone(true, null, false);
                    return;
                }
                if (onLines(splitter.push(data)) === false) {
                    cancellable.cancel();
                    this._killProc();
                    onDone(true, null, true);
                    return;
                }
                readNext();
            });
        };
        readNext();
    }

    // ------------------------------------------------------------ results

    _rankedFiles() {
        const limit = this._settings.get_int('max-results');
        const scored = this._fileItems.map(item => ({
            item,
            score: Lib.scorePath(item.path, this._words, this._cs, this._roots),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(x => x.item);
    }

    _publish(final) {
        if (!this._isOpen)
            return;
        const list = this._mode === 'content'
            ? this._contentItems
            : this._appItems.concat(this._rankedFiles());
        if (!list.length && (final || !this._running)) {
            this._showMessage(this._toolName ? 'No results.' : (this._toolNote || 'No results.'));
        } else if (list.length) {
            this._renderList(list);
        }
        const n = list.length;
        let text = `${n} result${n === 1 ? '' : 's'}`;
        if (this._running)
            text += ' · searching…';
        else if (this._truncated)
            text += ` · limited to ${this._settings.get_int('max-results')}`;
        if (this._toolName)
            text += ` · ${this._toolName}`;
        if (this._toolNote)
            text += ` · ${this._toolNote}`;
        this._statusLabel.text = text;
    }

    _cancelRender() {
        if (this._renderId) {
            GLib.source_remove(this._renderId);
            this._renderId = 0;
        }
        this._pending = [];
    }

    _clearList() {
        this._cancelRender();
        if (this._infoCancellable)
            this._infoCancellable.cancel();
        this._infoCancellable = new Gio.Cancellable();
        if (this._list)
            this._list.destroy_all_children();
        this._rows = [];
        this._items = [];
        this._sel = -1;
    }

    _showMessage(text) {
        this._clearList();
        this._pathLabel.text = ' ';
        this._list.add_child(this._tone(new St.Label({style_class: 'aex-message', text}), 'muted'));
    }

    // One flat list: no section headings, the badge on each row says what it is.
    _renderList(list) {
        this._clearList();
        this._pending = list.slice();

        this._renderBatch(40);
        const want = this._items.findIndex(i => this._itemKey(i) === this._selKey);
        this._select(want >= 0 ? want : 0);

        if (this._pending.length) {
            this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._renderBatch(60);
                if (this._pending.length)
                    return GLib.SOURCE_CONTINUE;
                this._renderId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _renderBatch(count) {
        if (!this._list)
            return;
        const words = this._words;
        for (let n = 0; n < count && this._pending.length; n++) {
            const item = this._pending.shift();
            const row = this._makeRow(item, words);
            this._list.add_child(row);
            this._rows.push(row);
            this._items.push(item);
        }
    }

    _label(markup, styleClass, ellipsize, tone) {
        const label = new St.Label({style_class: styleClass});
        label.clutter_text.ellipsize = ellipsize ?? Pango.EllipsizeMode.END;
        label.clutter_text.set_markup(markup);
        if (tone)
            this._tone(label, tone);
        return label;
    }

    _makeRow(item, words) {
        const cs = this._cs;
        const row = new St.Button({
            style_class: 'aex-row',
            reactive: true,
            can_focus: false,
            track_hover: true,
            x_expand: true,
        });
        const box = new St.BoxLayout({style_class: 'aex-row-box', x_expand: true});
        const icon = new St.Icon({
            style_class: 'aex-row-icon',
            icon_size: 28,
            gicon: Gio.ThemedIcon.new(item.kind === 'app' ? 'application-x-executable' : 'text-x-generic'),
        });
        const col = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        let badgeText;

        if (item.kind === 'app') {
            if (item.info.get_icon())
                icon.gicon = item.info.get_icon();
            col.add_child(this._label(Lib.highlightMarkup(item.name, words, cs), 'aex-title'));
            const sub = item.description || item.generic;
            if (sub)
                col.add_child(this._label(Lib.highlightMarkup(sub, words, cs), 'aex-subtitle', null, 'muted'));
            badgeText = 'App';
        } else {
            const name = Lib.basename(item.path);
            if (item.kind === 'content') {
                col.add_child(this._label(
                    `${Lib.escapeMarkup(name)}<span alpha="60%">  :${item.line}</span>`, 'aex-title'));
                col.add_child(this._label(
                    Lib.highlightMarkup(item.text, words, cs), 'aex-snippet', null, 'muted'));
                col.add_child(this._label(
                    Lib.escapeMarkup(item.path), 'aex-subtitle', Pango.EllipsizeMode.MIDDLE, 'muted'));
            } else {
                col.add_child(this._label(Lib.highlightMarkup(name, words, cs), 'aex-title'));
                col.add_child(this._label(
                    Lib.highlightMarkup(item.path, words, cs, item.rel ?? 0), 'aex-subtitle',
                    Pango.EllipsizeMode.MIDDLE, 'muted'));
            }
            const ext = Lib.extension(item.path);
            badgeText = ext && ext.length <= 5 ? ext.toUpperCase() : 'File';
        }

        const badge = new St.Label({
            style_class: 'aex-badge',
            text: badgeText,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (this._pal)
            badge.set_style(`color: ${this._pal.muted}; background-color: ${this._pal.soft};`);
        box.add_child(icon);
        box.add_child(col);
        box.add_child(badge);
        row.set_child(box);
        row.connect('clicked', () => {
            const i = this._rows.indexOf(row);
            if (i >= 0) {
                this._select(i);
                this._activateSelected({shift: false, ctrl: false});
            }
        });

        if (item.kind !== 'app')
            this._resolveFileInfo(item, icon, badge);
        return row;
    }

    _resolveFileInfo(item, icon, badge) {
        const cancellable = this._infoCancellable;
        const file = Gio.File.new_for_path(item.path);
        file.query_info_async('standard::type,standard::icon', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, cancellable, (src, res) => {
                try {
                    const info = src.query_info_finish(res);
                    const gicon = info.get_icon();
                    if (gicon)
                        icon.gicon = gicon;
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        badge.text = 'Folder';
                        item.isDir = true;
                    }
                } catch (_e) {
                    // cancelled, deleted or inaccessible: keep the placeholder
                }
            });
    }

    // ------------------------------------------------------------ actions

    _activateSelected({shift, ctrl}) {
        const item = this._items[this._sel];
        if (!item)
            return;
        this.close();
        try {
            if (ctrl)
                this._copy(item);
            else if (item.kind === 'app')
                this._launchApp(item, shift);
            else if (shift)
                this._reveal(item.path);
            else
                this._openPath(item.path);
        } catch (e) {
            console.error(`Aex Search: action failed: ${e}`);
            Main.notifyError('Aex Search', `${e.message ?? e}`);
        }
    }

    _launchApp(item, newWindow) {
        const app = Shell.AppSystem.get_default().lookup_app(item.id);
        if (app) {
            if (newWindow)
                app.open_new_window(-1);
            else
                app.activate();
        } else {
            item.info.launch([], global.create_app_launch_context(0, -1));
        }
    }

    _openPath(path) {
        const uri = Gio.File.new_for_path(path).get_uri();
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    }

    _reveal(path) {
        const uri = Gio.File.new_for_path(path).get_uri();
        Gio.DBus.session.call(
            'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems',
            new GLib.Variant('(ass)', [[uri], 'aex-search']), null,
            Gio.DBusCallFlags.NONE, 3000, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (_e) {
                    try {
                        this._openPath(Lib.dirname(path));
                    } catch (e) {
                        console.error(`Aex Search: reveal failed: ${e}`);
                        Main.notifyError('Aex Search', `${e.message ?? e}`);
                    }
                }
            });
    }

    _copy(item) {
        const text = item.kind === 'app' ? item.name : item.path;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        Main.notify('Aex Search', item.kind === 'app' ? 'Name copied' : 'Path copied to clipboard');
    }
}

class AexController {
    constructor(settings, openPrefs) {
        this._settings = settings;
        this._popup = new AexPopup(settings, openPrefs);
        this._bound = [];
    }

    enable() {
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
        for (const [key, mode] of KEYBINDINGS) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE, modes,
                () => this._popup.toggle(mode));
            this._bound.push(key);
        }
    }

    disable() {
        for (const key of this._bound)
            Main.wm.removeKeybinding(key);
        this._bound = [];
        this._popup.destroy();
        this._popup = null;
        this._settings = null;
    }
}

export default class AexSearchExtension extends Extension {
    enable() {
        this._controller = new AexController(this.getSettings(), () => this.openPreferences());
        this._controller.enable();
    }

    disable() {
        this._controller?.disable();
        this._controller = null;
    }
}