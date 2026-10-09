// SPDX-License-Identifier: GPL-3.0-or-later
// Colour palettes. Each phase has two shades:
//   vivid: the glow, the top bar and rings on dark surfaces
//   deep:  buttons (white text, at least 4.5:1) and rings on light surfaces

export const PALETTES = {
    dusk: {
        name: 'Dusk',
        focus: {vivid: '#7C7CF2', deep: '#6968D4'},
        short: {vivid: '#2FC1B0', deep: '#008275'},
        long: {vivid: '#B57EE6', deep: '#8F5FB8'},
    },
    ubuntu: {
        name: 'Ubuntu',
        focus: {vivid: '#E95420', deep: '#CF4511'},
        short: {vivid: '#2EC27E', deep: '#008550'},
        long: {vivid: '#3584E4', deep: '#2A75CF'},
    },
    pomodoro: {
        name: 'Pomodoro',
        focus: {vivid: '#EF4F3E', deep: '#D33F30'},
        short: {vivid: '#5BB16F', deep: '#3B834D'},
        long: {vivid: '#C9A33A', deep: '#8F7016'},
    },
    stone: {
        name: 'Stone',
        focus: {vivid: '#A9B1BF', deep: '#6E747F'},
        short: {vivid: '#93B9A0', deep: '#5E7B68'},
        long: {vivid: '#9DB2D3', deep: '#667690'},
    },
};

export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** Mixes `hex` towards white (t > 0) or black (t < 0). */
export function shade(hex, t) {
    const target = t > 0 ? 1 : 0;
    const k = Math.abs(t);
    return `#${hexToRgb(hex).map(c => Math.round((c + (target - c) * k) * 255)
        .toString(16).padStart(2, '0')).join('')}`;
}

/** The colours for one phase on a light or dark surface. */
export function phaseColors(paletteName, phase, dark) {
    const p = (PALETTES[paletteName] ?? PALETTES.dusk)[phase];
    return {ring: dark ? p.vivid : p.deep, fill: p.deep, vivid: p.vivid};
}
