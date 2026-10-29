// SPDX-License-Identifier: GPL-3.0-or-later
// Aex Search - color helpers for the custom theme (pure logic, no GNOME imports).

const LIGHT_TEXT = '#f3f3f5';
const DARK_TEXT = '#1d1d20';

export const DEFAULT_BG = '#1e1e22';
export const DEFAULT_ACCENT = '#3584e4';

// "#abc", "abc", "#AABBCC" -> "#aabbcc". Returns null when the input is not a valid hex color.
export function normalizeHex(input) {
    let h = String(input ?? '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(h))
        h = h.split('').map(c => c + c).join('');
    return /^[0-9a-f]{6}$/i.test(h) ? `#${h.toLowerCase()}` : null;
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(v) {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
}

// Picks whichever of the two text colors is easier to read on `bg`.
export function pickText(bg, light = LIGHT_TEXT, dark = DARK_TEXT) {
    const l = luminance(bg);
    return contrast(luminance(dark), l) >= contrast(luminance(light), l) ? dark : light;
}

// t = 0 -> a, t = 1 -> b
export function mix(a, b, t) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

export function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Everything the popup needs to paint itself from one background and one accent color.
export function buildPalette(bgInput, accentInput) {
    const bg = normalizeHex(bgInput) ?? DEFAULT_BG;
    const accent = normalizeHex(accentInput) ?? DEFAULT_ACCENT;
    const text = pickText(bg);
    const light = text === DARK_TEXT;
    return {
        light,
        bg,
        accent,
        text,
        muted: mix(bg, text, 0.65),
        faint: mix(bg, text, 0.5),
        soft: rgba(text, 0.08),
        border: rgba(text, 0.12),
        selected: rgba(accent, light ? 0.25 : 0.45),
        onAccent: pickText(accent, '#ffffff', '#1a1a1a'),
    };
}
