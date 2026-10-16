// SPDX-License-Identifier: GPL-3.0-or-later
// Aex Search - pure logic (no GNOME imports, so it can be unit-tested in Node).
// NOTE: only `function` and `var` declarations are used at top level so the same
// file works as a legacy (GNOME 42-44) import and, with an appended export list,
// as an ES module (GNOME 45+). build.py adds the exports.

var HL_BG = '#ffd84d';
var HL_FG = '#1a1a1a';

function escapeMarkup(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Length-preserving case fold (so indexes in the folded text match the original).
function fold(s) {
    let out = '';
    for (const ch of String(s)) {
        const l = ch.toLowerCase();
        out += l.length === ch.length ? l : ch;
    }
    return out;
}

function splitQuery(query, caseSensitive) {
    const words = [];
    const re = /"([^"]+)"|(\S+)/g;
    const src = String(query ?? '');
    let m;
    while ((m = re.exec(src)) !== null) {
        const w = (m[1] ?? m[2]).trim();
        if (w)
            words.push(caseSensitive ? w : fold(w));
    }
    return words;
}

function matchesAll(text, words, caseSensitive) {
    const hay = caseSensitive ? text : fold(text);
    return words.every(w => hay.includes(w));
}

function findRanges(text, words, caseSensitive, minIndex = 0) {
    if (!text || !words.length)
        return [];
    const hay = caseSensitive ? text : fold(text);
    const ranges = [];
    for (const w of words) {
        if (!w)
            continue;
        let i = Math.max(0, minIndex);
        while ((i = hay.indexOf(w, i)) !== -1) {
            ranges.push([i, i + w.length]);
            i += w.length;
        }
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1])
            last[1] = Math.max(last[1], r[1]);
        else
            merged.push([r[0], r[1]]);
    }
    return merged;
}

function highlightMarkup(text, words, caseSensitive, minIndex = 0) {
    const ranges = findRanges(text, words, caseSensitive, minIndex);
    let out = '';
    let pos = 0;
    for (const [a, b] of ranges) {
        out += escapeMarkup(text.slice(pos, a));
        out += `<span background="${HL_BG}" foreground="${HL_FG}">${escapeMarkup(text.slice(a, b))}</span>`;
        pos = b;
    }
    return out + escapeMarkup(text.slice(pos));
}

// ---------------------------------------------------------------- paths

function stripSlash(p) {
    if (p.length > 1 && p.endsWith('/'))
        return p.replace(/\/+$/, '') || '/';
    return p;
}

function basename(p) {
    const s = stripSlash(p);
    const i = s.lastIndexOf('/');
    return i < 0 ? s : (s.slice(i + 1) || s);
}

function dirname(p) {
    const s = stripSlash(p);
    const i = s.lastIndexOf('/');
    return i <= 0 ? '/' : s.slice(0, i);
}

function extension(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 && i < b.length - 1 ? b.slice(i + 1) : '';
}

// Longest configured root that contains `path`, or null. Root '/' gives ''.
function rootOf(path, roots) {
    let best = null;
    for (const r of roots) {
        const rr = r === '/' ? '' : stripSlash(r);
        if (path === rr || path.startsWith(rr + '/')) {
            if (best === null || rr.length > best.length)
                best = rr;
        }
    }
    return best;
}

// Index in `path` where the part below the search root begins.
function relStart(path, roots) {
    const r = rootOf(path, roots);
    return r === null ? 0 : r.length;
}

function globToRegex(g) {
    return new RegExp('^' + g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$');
}

// Returns segment => boolean. Entries are names or simple globs (* and ?).
function makeExcluder(list) {
    const exact = new Set();
    const regexes = [];
    for (const e of list ?? []) {
        const t = String(e).trim();
        if (!t)
            continue;
        if (/[*?]/.test(t))
            regexes.push(globToRegex(t));
        else
            exact.add(t);
    }
    return seg => exact.has(seg) || regexes.some(r => r.test(seg));
}

function isFiltered(path, roots, excluder, showHidden) {
    const r = rootOf(path, roots);
    if (r === null)
        return true;
    for (const seg of path.slice(r.length).split('/')) {
        if (!seg)
            continue;
        if (!showHidden && seg.startsWith('.'))
            return true;
        if (excluder(seg))
            return true;
    }
    return false;
}

// ---------------------------------------------------------------- ranking

function scorePath(path, words, caseSensitive, roots = []) {
    const name = caseSensitive ? basename(path) : fold(basename(path));
    let score = 0;
    for (const w of words) {
        if (name === w) {
            score += 100;
        } else if (name.startsWith(w)) {
            score += 60;
        } else if (name.includes(w)) {
            const idx = name.indexOf(w);
            const boundary = idx === 0 || /[\s._\-]/.test(name[idx - 1]);
            score += (boundary ? 45 : 35) - Math.min(idx, 20) / 4;
        } else {
            score += 10;
        }
    }
    const rel = path.slice(relStart(path, roots));
    const depth = rel.split('/').length - 1;
    return score - Math.min(rel.length, 400) / 25 - depth * 0.5;
}

function scoreApp(f, words) {
    if (!words.length)
        return 1;
    const name = fold(f.name ?? '');
    const generic = fold(f.generic ?? '');
    const keywords = fold(f.keywords ?? '');
    const id = fold(f.id ?? '');
    const desc = fold(f.description ?? '');
    const tokens = name.split(/[\s\-_.]+/);
    let total = 0;
    for (const w of words) {
        let best = -1;
        if (name === w)
            best = 100;
        else if (name.startsWith(w))
            best = 80;
        else if (tokens.some(t => t.startsWith(w)))
            best = 65;
        else if (name.includes(w))
            best = 50;
        else if (generic.includes(w))
            best = 35;
        else if (keywords.includes(w))
            best = 30;
        else if (id.includes(w))
            best = 20;
        else if (desc.includes(w))
            best = 10;
        if (best < 0)
            return -1;
        total += best;
    }
    return total;
}

// ---------------------------------------------------------------- tool command lines

// Prefer words that do not occur in the search roots: those would match everything.
function choosePatternWords(words, roots) {
    const rootText = fold(roots.join('\n'));
    const useful = words.filter(w => !rootText.includes(fold(w)));
    return useful.length ? useful : words;
}

function longest(words) {
    return words.reduce((a, b) => (b.length > a.length ? b : a), '');
}

// o: { words, roots, excludes, showHidden, cs, includeDirs }
function buildFdArgs(bin, o) {
    const pw = choosePatternWords(o.words, o.roots);
    const pat = longest(pw);
    const args = [bin, '--absolute-path', '--no-ignore', '--color', 'never', '--fixed-strings',
        o.cs ? '--case-sensitive' : '--ignore-case'];
    if (o.showHidden)
        args.push('--hidden');
    args.push('--type', 'f');
    if (o.includeDirs)
        args.push('--type', 'd');
    for (const e of o.excludes)
        args.push('--exclude', e);
    if (o.words.length > 1 || pat.includes('/'))
        args.push('--full-path');
    args.push('--', pat, ...o.roots);
    return args;
}

function escapeFindGlob(w) {
    return w.replace(/[\\*?[\]]/g, '\\$&');
}

function buildFindArgs(bin, o) {
    const args = [bin, ...o.roots];
    const names = [];
    if (!o.showHidden)
        names.push('.*');
    names.push(...o.excludes);
    if (names.length) {
        const expr = [];
        names.forEach((n, i) => {
            if (i)
                expr.push('-o');
            expr.push('-name', n);
        });
        args.push('(', '(', ...expr, ')', '-prune', ')', '-o');
    }
    args.push('(');
    if (o.includeDirs)
        args.push('(', '-type', 'f', '-o', '-type', 'd', ')');
    else
        args.push('-type', 'f');
    for (const w of choosePatternWords(o.words, o.roots))
        args.push(o.cs ? '-path' : '-ipath', `*${escapeFindGlob(w)}*`);
    args.push('-print', ')');
    return args;
}

function buildPlocateArgs(bin, o) {
    const pw = choosePatternWords(o.words, o.roots);
    const args = [bin];
    if (!o.cs)
        args.push('-i');
    args.push('-l', '50000');
    if (pw.length > 1)
        args.push('-A');
    else if (!pw[0].includes('/'))
        args.push('-b');
    args.push('--', ...pw);
    return args;
}

// o: { query, roots, excludes, showHidden, cs, regex, maxSizeMb }
function buildRgArgs(bin, o) {
    const args = [bin, '--no-config', '--no-heading', '--with-filename', '--line-number',
        '--color', 'never', '--no-messages', '--no-ignore', '--max-count', '5',
        '--max-filesize', `${o.maxSizeMb}M`, '--max-columns', '400', '--max-columns-preview',
        o.cs ? '--case-sensitive' : '--ignore-case'];
    if (!o.regex)
        args.push('--fixed-strings');
    if (o.showHidden)
        args.push('--hidden');
    for (const e of o.excludes)
        args.push('--glob', `!${e}`);
    args.push('--regexp', o.query, '--', ...o.roots);
    return args;
}

function buildGrepArgs(bin, o) {
    const args = [bin, '-rIn', '-H', '--color=never', '-m', '5'];
    if (!o.cs)
        args.push('-i');
    args.push(o.regex ? '-E' : '-F');
    if (!o.showHidden)
        args.push('--exclude-dir=.*', '--exclude=.*');
    for (const e of o.excludes)
        args.push(`--exclude-dir=${e}`, `--exclude=${e}`);
    args.push('-e', o.query, '--', ...o.roots);
    return args;
}

// "/path/to/file:123:matching text" -> {path, line, text}
function parseGrepLine(line) {
    const m = /^(\/.*?):(\d+):(.*)$/.exec(line);
    if (!m)
        return null;
    return {path: m[1], line: parseInt(m[2], 10), text: m[3].trim().slice(0, 240)};
}

// ---------------------------------------------------------------- recent files

function unescapeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseRecent(xml, limit = 100) {
    const entries = [];
    const re = /<bookmark\s+([^>]*)>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const href = /href="([^"]*)"/.exec(m[1]);
        const mod = /modified="([^"]*)"/.exec(m[1]);
        if (!href)
            continue;
        const uri = unescapeXml(href[1]);
        if (!uri.startsWith('file:///'))
            continue;
        let path;
        try {
            path = decodeURIComponent(uri.slice('file://'.length));
        } catch (_e) {
            continue;
        }
        entries.push({path, modified: mod ? mod[1] : ''});
    }
    entries.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    const seen = new Set();
    const out = [];
    for (const e of entries) {
        if (seen.has(e.path))
            continue;
        seen.add(e.path);
        out.push(e.path);
        if (out.length >= limit)
            break;
    }
    return out;
}

// ---------------------------------------------------------------- streaming

// Splits a byte stream into lines. Decodes only complete lines, so multi-byte
// UTF-8 characters are never cut in half and NUL bytes are harmless.
var LineSplitter = class LineSplitter {
    constructor(decode) {
        this._decode = decode;
        this._rest = new Uint8Array(0);
    }

    push(chunk) {
        let buf = chunk;
        if (this._rest.length) {
            buf = new Uint8Array(this._rest.length + chunk.length);
            buf.set(this._rest, 0);
            buf.set(chunk, this._rest.length);
        }
        const last = buf.lastIndexOf(10);
        if (last < 0) {
            this._rest = buf.slice();
            return [];
        }
        const text = this._decode(buf.subarray(0, last));
        this._rest = buf.slice(last + 1);
        return text.split('\n').filter(l => l.length > 0);
    }

    finish() {
        if (!this._rest.length)
            return [];
        const text = this._decode(this._rest);
        this._rest = new Uint8Array(0);
        return text.split('\n').filter(l => l.length > 0);
    }
};

export {HL_BG, HL_FG, LineSplitter, basename, buildFdArgs, buildFindArgs, buildGrepArgs, buildPlocateArgs, buildRgArgs, choosePatternWords, dirname, escapeFindGlob, escapeMarkup, extension, findRanges, fold, globToRegex, highlightMarkup, isFiltered, longest, makeExcluder, matchesAll, parseGrepLine, parseRecent, relStart, rootOf, scoreApp, scorePath, splitQuery, stripSlash, unescapeXml};
