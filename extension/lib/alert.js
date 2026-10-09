// SPDX-License-Identifier: GPL-3.0-or-later
// The time's-up card and the screen-edge glow, drawn by GNOME Shell above all windows.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {drawBadge, drawGlowEdge} from './drawing.js';
import {formatClock} from './timer.js';

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function pointerMonitor() {
    const [x, y] = global.get_pointer();
    return Main.layoutManager.monitors.find(m =>
        x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ?? Main.layoutManager.primaryMonitor;
}

/** A small card that slides in at the top of the screen and stays until you act on it. */
export class AlertCard {
    constructor({phase, title, subtitle, primary, secondary, onPrimary, onSecondary, onClose, endedAt, dark}) {
        this._endedAt = endedAt;
        this._closing = false;

        this.actor = new St.BoxLayout({
            style_class: `fermata-alert fermata-${phase} ${dark ? 'fermata-dark' : 'fermata-light'}`,
            reactive: true,
        });

        // A slow ripple behind the badge: movement in the corner of your eye, not a flashing light.
        const badgeBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'fermata-badge-box',
            y_align: Clutter.ActorAlign.START,
        });
        this._ripple = new St.Widget({style_class: 'fermata-ripple'});
        const badge = new St.DrawingArea({style_class: 'fermata-badge'});
        badge.connect('repaint', area => drawBadge(area, phase));
        badgeBox.add_child(this._ripple);
        badgeBox.add_child(badge);
        this.actor.add_child(badgeBox);

        const column = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'fermata-alert-text'});
        const header = new St.BoxLayout();
        header.add_child(new St.Label({text: title, style_class: 'fermata-alert-title', x_expand: true}));
        this._overtime = new St.Label({style_class: 'fermata-alert-overtime', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._overtime);
        const close = new St.Button({
            style_class: 'fermata-alert-close',
            icon_name: 'window-close-symbolic',
            accessible_name: 'Dismiss',
            can_focus: true,
        });
        close.connect('clicked', () => onClose());
        header.add_child(close);
        column.add_child(header);
        column.add_child(new St.Label({text: subtitle, style_class: 'fermata-alert-subtitle'}));

        const buttons = new St.BoxLayout({style_class: 'fermata-alert-buttons'});
        for (const [label, style, callback] of [[primary, 'fermata-primary', onPrimary],
            [secondary, 'fermata-secondary', onSecondary]]) {
            if (!label)
                continue;
            const button = new St.Button({label, style_class: `fermata-button ${style}`, can_focus: true});
            button.connect('clicked', () => callback());
            buttons.add_child(button);
        }
        column.add_child(buttons);
        this.actor.add_child(column);
        this.update();
    }

    show() {
        // Above every window, fullscreen ones included, but never takes keyboard focus.
        Main.layoutManager.addTopChrome(this.actor, {affectsInputRegion: true});
        const area = Main.layoutManager.getWorkAreaForMonitor(pointerMonitor().index);
        const [, width] = this.actor.get_preferred_width(-1);
        this.actor.set_position(Math.round(area.x + (area.width - width) / 2), area.y + 12 * scaleFactor());

        this.actor.opacity = 0;
        this.actor.translation_y = -16 * scaleFactor();
        this.actor.ease({
            opacity: 255,
            translation_y: 0,
            duration: 320,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._startRipple();
    }

    _startRipple() {
        this._ripple.set_pivot_point(0.5, 0.5);
        this._ripple.remove_all_transitions();
        this._ripple.set({scale_x: 1, scale_y: 1, opacity: 160});
        this._ripple.ease({
            scale_x: 1.6,
            scale_y: 1.6,
            opacity: 0,
            duration: 2600,
            repeatCount: -1,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    update() {
        this._overtime.text = this._endedAt === null ? ''
            : `+${formatClock(Math.max(0, Date.now() / 1000 - this._endedAt))}`;
    }

    /** A reminder: a brief swell of the card and a fresh ripple. */
    nudge() {
        this.actor.set_pivot_point(0.5, 0);
        this.actor.ease({
            scale_x: 1.03,
            scale_y: 1.03,
            duration: 160,
            autoReverse: true,
            repeatCount: 3,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._startRipple();
    }

    close() {
        if (this._closing)
            return;
        this._closing = true;
        this._ripple.remove_all_transitions();
        this.actor.ease({
            opacity: 0,
            translation_y: -10 * scaleFactor(),
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this.actor.destroy(),
        });
    }

    destroy() {
        this.actor.destroy();
    }
}

/** A soft glow that pulses around every screen edge a few times, then fades. Never takes input. */
export class EdgeGlow {
    static DURATION = 4400; // ms
    static PULSES = [[0, 1], [1.35, 0.8], [2.7, 0.6]]; // [start s, strength]

    constructor(phase, onDone) {
        this._actors = [];
        const depth = Math.round(72 * scaleFactor());
        for (const monitor of Main.layoutManager.monitors) {
            // Inside the work area, so the glow isn't hidden under the top bar or dock.
            const a = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            const edges = {
                top: [a.x, a.y, a.width, depth],
                bottom: [a.x, a.y + a.height - depth, a.width, depth],
                left: [a.x, a.y, depth, a.height],
                right: [a.x + a.width - depth, a.y, depth, a.height],
            };
            for (const [edge, [x, y, width, height]] of Object.entries(edges)) {
                const actor = new St.DrawingArea({x, y, width, height, opacity: 0, reactive: false});
                actor.connect('repaint', area => drawGlowEdge(area, edge, phase));
                Main.layoutManager.addTopChrome(actor, {affectsInputRegion: false});
                this._actors.push(actor);
            }
        }

        // Fading whole actors leaves the work to the GPU: the gradients are painted once.
        this._timeline = new Clutter.Timeline({actor: this._actors[0], duration: EdgeGlow.DURATION});
        this._timeline.connect('new-frame', (_timeline, msecs) => {
            const opacity = Math.round(255 * EdgeGlow.level(msecs / 1000));
            for (const actor of this._actors)
                actor.opacity = opacity;
        });
        this._timeline.connect('completed', () => {
            this.destroy();
            onDone?.();
        });
        this._timeline.start();
    }

    static level(t) {
        let value = 0;
        for (const [start, strength] of EdgeGlow.PULSES) {
            const u = t - start;
            if (u >= 0)
                value += strength * (u < 0.22 ? u / 0.22 : Math.exp(-(u - 0.22) / 0.5));
        }
        return Math.min(1, value);
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        for (const actor of this._actors)
            actor.destroy();
        this._actors = [];
    }
}
