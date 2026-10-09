// SPDX-License-Identifier: GPL-3.0-or-later
// Cairo drawing: the top bar stopwatch, the badges on the cards, and the screen glow.

import Cairo from 'cairo';

import {hexToRgb} from './palette.js';

/** The theme node's foreground colour as [r, g, b] in 0..1. */
function foreground(actor) {
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
 * `tint` colours the ring (null: the panel's text colour); `dot` is the time's-up colour.
 */
export function drawStopwatch(area, {fraction, state, tint, dot}) {
    const cr = area.get_context();
    const [w] = area.get_surface_size();
    cr.scale(w / 16, w / 16);
    const fg = foreground(area);
    const cx = 8, cy = 8.9, r = 5.4, lw = 1.9;

    if (state === 'done') {
        cr.setSourceRGBA(...hexToRgb(dot), 1);
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
    const ring = tint ? hexToRgb(tint) : fg;
    cr.setSourceRGBA(...fg, strong);
    roundedRect(cr, 6.4, 0.55, 3.2, 1.75, 0.8);
    cr.fill();

    cr.setLineWidth(lw);
    cr.setSourceRGBA(...ring, 0.3);
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    cr.stroke();

    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGBA(...ring, strong);
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

// Glyphs drawn in a 44 × 44 box centred on (22, 22).
const GLYPHS = {
    stopwatch(cr) {
        cr.setLineWidth(2.4);
        cr.arc(22, 23.6, 9.6, 0, 2 * Math.PI);
        cr.stroke();
        roundedRect(cr, 19.4, 10.8, 5.2, 2.7, 1.1);
        cr.fill();
    },
    check(cr) {
        GLYPHS.stopwatch(cr);
        cr.setLineWidth(2.3);
        cr.moveTo(18.1, 23.9);
        cr.lineTo(20.9, 26.6);
        cr.lineTo(26.0, 21.3);
        cr.stroke();
    },
    pause(cr) {
        roundedRect(cr, 16.8, 15.5, 3.6, 13, 1.4);
        roundedRect(cr, 23.6, 15.5, 3.6, 13, 1.4);
        cr.fill();
    },
    cup(cr) {
        cr.setLineWidth(2.3);
        cr.moveTo(13.5, 19);
        cr.lineTo(27.5, 19);
        cr.lineTo(27.5, 26);
        cr.arc(23, 26, 4.5, 0, Math.PI / 2);
        cr.lineTo(18, 30.5);
        cr.arc(18, 26, 4.5, Math.PI / 2, Math.PI);
        cr.closePath();
        cr.stroke();
        cr.arc(28.6, 23.2, 3.1, -Math.PI / 2, Math.PI / 2);
        cr.stroke();
        cr.setLineWidth(1.9);
        for (const x of [18.3, 22.7]) {
            cr.moveTo(x, 15.6);
            cr.curveTo(x - 1.6, 14.2, x + 1.6, 12.6, x, 11.2);
            cr.stroke();
        }
    },
};

/**
 * A badge: a tinted disc with a glyph. With `fraction` set, a progress ring runs round it.
 * Drawn to fit whatever size the area has.
 */
export function drawBadge(area, {color, glyph, fraction = null, paused = false}) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const size = fraction === null ? 44 : 54;
    const s = Math.min(w, h) / size;
    cr.scale(s, s);
    const rgb = hexToRgb(color);
    const c = size / 2;

    // With a ring round it, the disc and glyph shrink a little to leave air between them.
    const inner = fraction === null ? 1 : 0.88;
    cr.setSourceRGBA(...rgb, 0.13);
    cr.arc(c, c, 22 * inner, 0, 2 * Math.PI);
    cr.fill();

    if (fraction !== null) {
        cr.setLineWidth(3);
        cr.setSourceRGBA(...rgb, 0.2);
        cr.arc(c, c, 25.5, 0, 2 * Math.PI);
        cr.stroke();
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(...rgb, paused ? 0.55 : 1);
        remainingArc(cr, c, c, 25.5, fraction);
        cr.stroke();
    }

    cr.translate(c, c);
    cr.scale(inner, inner);
    cr.translate(-22, -22);
    cr.setSourceRGBA(...rgb, 1);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    GLYPHS[glyph](cr);
    cr.$dispose();
}

// How the glow fades from the screen edge inwards.
const GLOW_FALLOFF = [[0, 1], [0.1, 0.72], [0.28, 0.4], [0.52, 0.15], [0.78, 0.04], [1, 0]];

/**
 * One edge of the screen glow, drawn as a mitred trapezoid. Where two edges meet,
 * both have the same distance to their edge, so the corners join without a seam.
 * `edge` is 'top' | 'bottom' | 'left' | 'right'; the area is the glow's depth thick.
 */
export function drawGlowEdge(area, edge, color, peak = 0.62) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const [r, g, b] = hexToRgb(color);
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
