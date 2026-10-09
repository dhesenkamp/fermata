// SPDX-License-Identifier: GPL-3.0-or-later
// Cairo drawing for the stopwatch glyph, the card's progress ring and the alert badge.

import Cairo from 'cairo';

import {FOCUS, SHORT, LONG} from './timer.js';

// Ubuntu orange for focus, a calm green and blue for the breaks.
export const ACCENT = {[FOCUS]: '#E95420', [SHORT]: '#2EC27E', [LONG]: '#3584E4'};
// Lighter tints for the dark top bar.
const PANEL_TINT = {[SHORT]: '#8FF0A4', [LONG]: '#99C1F1'};
const PANEL_ALERT = {[FOCUS]: '#FF7A45', [SHORT]: '#57E389', [LONG]: '#62A0EA'};

export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** The theme node's foreground colour as [r, g, b] in 0..1. */
export function foreground(actor) {
    const c = actor.get_theme_node().get_foreground_color();
    return [c.red / 255, c.green / 255, c.blue / 255];
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

/** An arc that empties clockwise from 12 o'clock as `fraction` goes from 1 to 0. */
function remainingArc(cr, cx, cy, r, fraction) {
    if (fraction >= 0.999) {
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
    } else if (fraction > 0) {
        const top = -Math.PI / 2;
        cr.arc(cx, cy, r, top + 2 * Math.PI * (1 - fraction), top + 2 * Math.PI);
    }
}

/**
 * The top bar glyph: a stopwatch whose ring empties as time runs down.
 * `state` is the timer state; `phase` and `upcoming` pick the colours.
 */
export function drawStopwatch(area, {fraction, state, phase, upcoming}) {
    const cr = area.get_context();
    const [w] = area.get_surface_size();
    const s = w / 16;
    cr.scale(s, s);
    const fg = foreground(area);
    const cx = 8, cy = 8.9, r = 5.4, lw = 1.9;

    if (state === 'done') {
        // Time's up: a solid dot in the colour of what comes next.
        const [ar, ag, ab] = hexToRgb(PANEL_ALERT[upcoming]);
        cr.setSourceRGBA(ar, ag, ab, 1);
        roundedRect(cr, 6.4, 0.55, 3.2, 1.75, 0.8);
        cr.fill();
        cr.arc(cx, cy, r + lw / 2, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.arc(cx, cy, 1.7, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
        return;
    }

    const strong = state === 'paused' ? 0.6 : 1;
    const tint = phase === FOCUS ? fg : hexToRgb(PANEL_TINT[phase]);
    cr.setSourceRGBA(...fg, strong);
    roundedRect(cr, 6.4, 0.55, 3.2, 1.75, 0.8);
    cr.fill();

    cr.setLineWidth(lw);
    cr.setSourceRGBA(...tint, 0.3);
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    cr.stroke();

    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGBA(...tint, strong);
    remainingArc(cr, cx, cy, r, state === 'idle' ? 1 : fraction);
    cr.stroke();

    if (state === 'paused') {
        cr.setSourceRGBA(...fg, 1);
        roundedRect(cr, 6.35, 7.1, 1.2, 3.6, 0.5);
        roundedRect(cr, 8.45, 7.1, 1.2, 3.6, 0.5);
        cr.fill();
    }
    cr.$dispose();
}

/** The card's big progress ring. */
export function drawProgressRing(area, {fraction, accentPhase: phase, state}) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const lw = Math.max(4, w * 0.055);
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - lw / 2 - 1;
    const fg = foreground(area);
    const accent = hexToRgb(ACCENT[phase]);

    cr.setLineWidth(lw);
    cr.setSourceRGBA(...fg, 0.1);
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    cr.stroke();

    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGBA(...accent, state === 'paused' ? 0.55 : 1);
    remainingArc(cr, cx, cy, r, state === 'done' || state === 'idle' ? 1 : fraction);
    cr.stroke();
    cr.$dispose();
}

/** The alert badge: a tinted disc with a stopwatch and a check mark. */
export function drawBadge(area, phase) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const s = Math.min(w, h) / 44;
    cr.scale(s, s);
    const [r, g, b] = hexToRgb(ACCENT[phase]);
    const cx = 22, cy = 22;

    cr.setSourceRGBA(r, g, b, 0.14);
    cr.arc(cx, cy, 22, 0, 2 * Math.PI);
    cr.fill();

    cr.setSourceRGBA(r, g, b, 1);
    cr.setLineWidth(2.4);
    cr.arc(cx, cy + 1.6, 9.6, 0, 2 * Math.PI);
    cr.stroke();
    roundedRect(cr, cx - 2.6, cy + 1.6 - 9.6 - 1.2 - 3.0, 5.2, 2.7, 1.1);
    cr.fill();

    cr.setLineWidth(2.3);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.moveTo(cx - 3.9, cy + 1.9);
    cr.lineTo(cx - 1.1, cy + 4.6);
    cr.lineTo(cx + 4.0, cy - 0.7);
    cr.stroke();
    cr.$dispose();
}

// How the glow fades from the screen edge inwards.
const GLOW_FALLOFF = [[0, 1], [0.1, 0.72], [0.28, 0.4], [0.52, 0.15], [0.78, 0.04], [1, 0]];

/**
 * One edge of the screen glow, drawn as a mitred trapezoid. Where two edges meet,
 * both have the same distance to their edge, so the corners join without a seam.
 * `edge` is 'top' | 'bottom' | 'left' | 'right'; the area is `depth` thick.
 */
export function drawGlowEdge(area, edge, phase, peak = 0.62) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const [r, g, b] = hexToRgb(ACCENT[phase]);
    const d = edge === 'top' || edge === 'bottom' ? h : w;
    const shapes = {
        top: [[[0, 0], [w, 0], [w - d, d], [d, d]], [0, 0, 0, d]],
        bottom: [[[0, h], [w, h], [w - d, h - d], [d, h - d]], [0, h, 0, h - d]],
        left: [[[0, 0], [0, h], [d, h - d], [d, d]], [0, 0, d, 0]],
        right: [[[w, 0], [w, h], [w - d, h - d], [w - d, d]], [w, 0, w - d, 0]],
    };
    const [points, vector] = shapes[edge];
    cr.setAntialias(Cairo.Antialias.NONE);
    cr.moveTo(...points[0]);
    for (const p of points.slice(1))
        cr.lineTo(...p);
    cr.closePath();
    const gradient = new Cairo.LinearGradient(...vector);
    for (const [offset, k] of GLOW_FALLOFF)
        gradient.addColorStopRGBA(offset, r, g, b, peak * k);
    cr.setSource(gradient);
    cr.fill();
    cr.$dispose();
}
