// SPDX-License-Identifier: GPL-3.0-or-later
// Aex Search - https://github.com/aexinide/aex-search

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Shared preferences body. Only uses widgets that exist in libadwaita 1.1
// (GNOME 42 / Ubuntu 22.04) and newer. Expects in scope: Adw, Gdk, Gio, GLib, Gtk.

const SHORTCUTS = [
    ['shortcut-all', 'Search everything', 'Apps, files and folders'],
    ['shortcut-files', 'Search files and folders', 'No applications'],
    ['shortcut-apps', 'Search applications', 'Applications only'],
    ['shortcut-content', 'Search inside files', 'Find text within documents and code'],
];

let _chooser = null;

function _row(title, subtitle) {
    return new Adw.ActionRow({
        title: GLib.markup_escape_text(title, -1),
        subtitle: subtitle ? GLib.markup_escape_text(subtitle, -1) : '',
    });
}

function _switchRow(group, settings, key, title, subtitle) {
    const row = _row(title, subtitle);
    const sw = new Gtk.Switch({valign: Gtk.Align.CENTER});
    settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(sw);
    row.activatable_widget = sw;
    group.add(row);
}

function _spinRow(group, settings, key, title, subtitle, min, max, step) {
    const row = _row(title, subtitle);
    const spin = new Gtk.SpinButton({
        valign: Gtk.Align.CENTER,
        numeric: true,
        adjustment: new Gtk.Adjustment({
            lower: min, upper: max, step_increment: step, page_increment: step * 10,
        }),
    });
    settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(spin);
    row.activatable_widget = spin;
    group.add(row);
}

function _comboRow(group, settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title: GLib.markup_escape_text(title, -1),
        subtitle: subtitle ? GLib.markup_escape_text(subtitle, -1) : '',
        model: Gtk.StringList.new(choices.map(c => c[1])),
    });
    const cur = settings.get_string(key);
    row.selected = Math.max(0, choices.findIndex(c => c[0] === cur));
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice && settings.get_string(key) !== choice[0])
            settings.set_string(key, choice[0]);
    });
    group.add(row);
}

function _chooseFolder(window, callback) {
    if (Gtk.FileDialog) {
        const dialog = new Gtk.FileDialog({title: 'Choose a folder to search'});
        dialog.select_folder(window, null, (d, res) => {
            try {
                const file = d.select_folder_finish(res);
                if (file)
                    callback(file.get_path());
            } catch (_e) {
                // dismissed
            }
        });
        return;
    }
    _chooser = new Gtk.FileChooserNative({
        title: 'Choose a folder to search',
        transient_for: window,
        modal: true,
        action: Gtk.FileChooserAction.SELECT_FOLDER,
    });
    _chooser.connect('response', (dlg, id) => {
        if (id === Gtk.ResponseType.ACCEPT)
            callback(dlg.get_file().get_path());
        dlg.destroy();
        _chooser = null;
    });
    _chooser.show();
}

// Keeps `group` populated with one removable row per entry of the strv setting.
function _listEditor(group, settings, key, track) {
    let rows = [];
    const refresh = () => {
        rows.forEach(r => group.remove(r));
        rows = [];
        for (const [i, value] of settings.get_strv(key).entries()) {
            const row = _row(value, '');
            const btn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Remove',
                css_classes: ['flat'],
            });
            btn.connect('clicked', () => {
                const cur = settings.get_strv(key);
                cur.splice(i, 1);
                settings.set_strv(key, cur);
            });
            row.add_suffix(btn);
            group.add(row);
            rows.push(row);
        }
    };
    track(`changed::${key}`, refresh);
    refresh();
    return value => {
        const cur = settings.get_strv(key);
        if (value && !cur.includes(value)) {
            cur.push(value);
            settings.set_strv(key, cur);
        }
    };
}

function _accelLabel(accel) {
    if (!accel)
        return 'Disabled';
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok ? Gtk.accelerator_get_label(key, mods) : accel;
}

function _shortcutRow(window, group, settings, key, title, subtitle, track) {
    const row = _row(title, subtitle);
    const label = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['dim-label']});
    const set = new Gtk.Button({label: 'Change…', valign: Gtk.Align.CENTER});
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Reset to default',
        css_classes: ['flat'],
    });
    const update = () => {
        label.label = _accelLabel(settings.get_strv(key)[0] ?? '');
    };
    track(`changed::${key}`, update);
    update();

    reset.connect('clicked', () => settings.reset(key));
    set.connect('clicked', () => _recordShortcut(window, settings, key, title));

    row.add_suffix(label);
    row.add_suffix(set);
    row.add_suffix(reset);
    group.add(row);
}

function _recordShortcut(window, settings, key, title) {
    const dlg = new Gtk.Window({
        modal: true,
        transient_for: window,
        title: 'Set shortcut',
        resizable: false,
        default_width: 380,
        default_height: 170,
    });
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24,
        valign: Gtk.Align.CENTER,
    });
    box.append(new Gtk.Label({label: `<b>${GLib.markup_escape_text(title, -1)}</b>`, use_markup: true}));
    box.append(new Gtk.Label({
        label: 'Press the new key combination.\nEsc cancels, Backspace disables the shortcut.',
        justify: Gtk.Justification.CENTER,
        css_classes: ['dim-label'],
    }));
    dlg.set_child(box);

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask();
        if (!mask && keyval === Gdk.KEY_Escape) {
            dlg.close();
            return true;
        }
        if (!mask && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(key, []);
            dlg.close();
            return true;
        }
        if (!mask || !Gtk.accelerator_valid(keyval, mask))
            return true;
        const accel = Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mask);
        for (const [other] of SHORTCUTS) {
            if (other !== key && settings.get_strv(other).includes(accel)) {
                window.add_toast(new Adw.Toast({
                    title: `${_accelLabel(accel)} is already used by another Aex Search shortcut`,
                }));
                dlg.close();
                return true;
            }
        }
        settings.set_strv(key, [accel]);
        dlg.close();
        return true;
    });
    dlg.add_controller(controller);
    dlg.present();
}

function _toolRow(group, name, packageName, purpose) {
    const path = GLib.find_program_in_path(name) || (name === 'fd' ? GLib.find_program_in_path('fdfind') : null);
    const row = _row(`${name}`, path ? `${purpose} – found at ${path}` : `${purpose} – not installed (sudo apt install ${packageName})`);
    row.add_suffix(new Gtk.Image({
        icon_name: path ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
        valign: Gtk.Align.CENTER,
    }));
    group.add(row);
}

function buildPrefs(window, settings) {
    const ids = [];
    const track = (signal, cb) => ids.push(settings.connect(signal, cb));
    window.connect('close-request', () => {
        ids.forEach(id => settings.disconnect(id));
        ids.length = 0;
        return false;
    });
    window.set_default_size(720, 800);

    // ---- General
    const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    const look = new Adw.PreferencesGroup({title: 'Appearance'});
    _comboRow(look, settings, 'theme', 'Theme', 'Follow the system or force a style',
        [['system', 'Follow system'], ['dark', 'Dark'], ['light', 'Light']]);
    _spinRow(look, settings, 'popup-width', 'Popup width', 'In pixels', 420, 1400, 20);
    general.add(look);

    const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
    _switchRow(behaviour, settings, 'show-recent', 'Show recent files',
        'Shown when the search box is empty');
    _spinRow(behaviour, settings, 'max-results', 'Maximum results', 'Between 10 and 2000', 10, 2000, 10);
    _spinRow(behaviour, settings, 'debounce-ms', 'Typing delay', 'Milliseconds to wait after typing before searching',
        0, 1000, 20);
    general.add(behaviour);

    const shortcuts = new Adw.PreferencesGroup({
        title: 'Keyboard shortcuts',
        description: 'Ctrl+Shift+S/F/A are also used by some applications (for example “Save As”). Rebind them here if they clash.',
    });
    for (const [key, title, sub] of SHORTCUTS)
        _shortcutRow(window, shortcuts, settings, key, title, sub, track);
    general.add(shortcuts);
    window.add(general);

    // ---- Search
    const search = new Adw.PreferencesPage({title: 'Search', icon_name: 'system-search-symbolic'});

    const dirs = new Adw.PreferencesGroup({
        title: 'Folders to search',
        description: 'Leave empty to search your home folder.',
    });
    const addRow = new Adw.ActionRow({title: 'Add folder…', activatable: true});
    addRow.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
    dirs.add(addRow);
    const addDir = _listEditor(dirs, settings, 'search-dirs', track);
    addRow.connect('activated', () => _chooseFolder(window, addDir));
    search.add(dirs);

    const filters = new Adw.PreferencesGroup({title: 'Filters'});
    _switchRow(filters, settings, 'show-hidden', 'Include hidden files', 'Names starting with a dot');
    _switchRow(filters, settings, 'include-folders', 'Include folders', 'Show folders in file results');
    _switchRow(filters, settings, 'case-sensitive', 'Case sensitive', 'Match upper and lower case exactly');
    search.add(filters);

    const excludes = new Adw.PreferencesGroup({
        title: 'Excluded names',
        description: 'Files and folders with these names are skipped. * and ? wildcards are allowed.',
    });
    const entryRow = new Adw.ActionRow({title: 'Add name'});
    const entry = new Gtk.Entry({
        placeholder_text: 'node_modules   or   *.log',
        valign: Gtk.Align.CENTER,
        width_chars: 22,
    });
    const addBtn = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
    entryRow.add_suffix(entry);
    entryRow.add_suffix(addBtn);
    excludes.add(entryRow);
    const addName = _listEditor(excludes, settings, 'exclude-names', track);
    const submit = () => {
        addName(entry.get_text().trim());
        entry.set_text('');
    };
    entry.connect('activate', submit);
    addBtn.connect('clicked', submit);
    search.add(excludes);
    window.add(search);

    // ---- Tools
    const tools = new Adw.PreferencesPage({title: 'Tools', icon_name: 'applications-engineering-symbolic'});

    const fileTools = new Adw.PreferencesGroup({title: 'File name search'});
    _comboRow(fileTools, settings, 'search-tool', 'Search tool',
        'Automatic uses fd when installed, otherwise find',
        [['auto', 'Automatic'], ['fd', 'fd (fast)'], ['find', 'find (always available)'],
            ['plocate', 'plocate (indexed)']]);
    _toolRow(fileTools, 'fd', 'fd-find', 'Fast live search');
    _toolRow(fileTools, 'plocate', 'plocate', 'Instant indexed search (needs a recent index)');
    tools.add(fileTools);

    const contentTools = new Adw.PreferencesGroup({title: 'Search inside files'});
    _comboRow(contentTools, settings, 'content-tool', 'Search tool',
        'Automatic uses ripgrep when installed, otherwise grep',
        [['auto', 'Automatic'], ['rg', 'ripgrep (fast)'], ['grep', 'grep']]);
    _switchRow(contentTools, settings, 'content-regex', 'Regular expressions',
        'Treat the query as a regular expression');
    _spinRow(contentTools, settings, 'content-max-size-mb', 'Maximum file size (MB)',
        'Larger files are skipped (ripgrep only)', 1, 200, 1);
    _toolRow(contentTools, 'rg', 'ripgrep', 'Fast content search');
    tools.add(contentTools);

    const reset = new Adw.PreferencesGroup();
    const resetRow = new Adw.ActionRow({title: 'Reset all settings to defaults', activatable: true});
    resetRow.add_css_class('error');
    resetRow.connect('activated', () => {
        for (const k of settings.settings_schema.list_keys())
            settings.reset(k);
    });
    reset.add(resetRow);
    tools.add(reset);
    window.add(tools);
}

export default class AexSearchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        buildPrefs(window, this.getSettings());
    }
}
