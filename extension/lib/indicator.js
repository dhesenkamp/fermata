// SPDX-License-Identifier: GPL-3.0-or-later
// The top bar button and the small card it opens.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {drawProgressRing, drawStopwatch} from './drawing.js';

/** What the card shows: a big ring with the time, the round, the controls and today's total. */
class TimerCard {
    constructor(controller, closeMenu) {
        this.actor = new St.BoxLayout({vertical: true, style_class: 'fermata-card'});

        const ringStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'fermata-ring-stack',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._ring = new St.DrawingArea({style_class: 'fermata-ring'});
        this._ring.connect('repaint', area => this._view && drawProgressRing(area, this._view));
        ringStack.add_child(this._ring);
        const centre = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._time = new St.Label({style_class: 'fermata-time', x_align: Clutter.ActorAlign.CENTER});
        this._phase = new St.Label({style_class: 'fermata-phase', x_align: Clutter.ActorAlign.CENTER, opacity: 170});
        centre.add_child(this._time);
        centre.add_child(this._phase);
        ringStack.add_child(centre);
        this.actor.add_child(ringStack);

        this._round = new St.Label({style_class: 'fermata-round', x_align: Clutter.ActorAlign.CENTER, opacity: 170});
        this.actor.add_child(this._round);

        const controls = new St.BoxLayout({style_class: 'fermata-controls', x_align: Clutter.ActorAlign.CENTER});
        this._primary = new St.Button({style_class: 'fermata-button fermata-primary', can_focus: true});
        this._primary.connect('clicked', () => controller.primary());
        controls.add_child(this._primary);
        this._extend = this._iconButton(controls, null, '+5', 'Add five minutes', () => controller.extend());
        this._skip = this._iconButton(controls, 'media-skip-forward-symbolic', null, 'Skip',
            () => controller.skip());
        this._reset = this._iconButton(controls, 'view-refresh-symbolic', null, 'Reset',
            () => controller.reset());
        this.actor.add_child(controls);

        const footer = new St.BoxLayout({style_class: 'fermata-footer'});
        this._today = new St.Label({
            style_class: 'fermata-today', x_expand: true, y_align: Clutter.ActorAlign.CENTER, opacity: 170,
        });
        footer.add_child(this._today);
        this._iconButton(footer, 'emblem-system-symbolic', null, 'Preferences', () => {
            closeMenu();
            controller.openPreferences();
        });
        this.actor.add_child(footer);
    }

    _iconButton(parent, iconName, label, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'fermata-icon-button',
            accessible_name: accessibleName,
            can_focus: true,
            ...iconName ? {icon_name: iconName} : {label},
        });
        button.connect('clicked', () => callback());
        parent.add_child(button);
        return button;
    }

    update(view) {
        this._view = view;
        this._ring.queue_repaint();
        this._time.text = view.timeText;
        this._phase.text = view.phaseText;
        this._round.text = view.roundText;
        this._round.visible = view.roundText !== '';
        this._primary.label = view.primaryLabel;
        for (const phase of ['focus', 'short', 'long'])
            this._primary.remove_style_class_name(`fermata-${phase}`);
        this._primary.add_style_class_name(`fermata-${view.accentPhase}`);
        this.actor.set_style_class_name(`fermata-card${view.state === 'done' ? ' fermata-card-done' : ''}`);
        this._extend.visible = view.state !== 'idle';
        this._skip.visible = view.state !== 'done';
        this._reset.visible = !view.pristine;
        this._today.text = view.todayText;
    }
}

export const FermataIndicator = GObject.registerClass(
class FermataIndicator extends PanelMenu.Button {
    _init(controller) {
        super._init(0.5, 'Fermata', false);
        this._controller = controller;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box fermata-panel'});
        this._glyph = new St.DrawingArea({style_class: 'fermata-glyph', y_align: Clutter.ActorAlign.CENTER});
        this._glyph.connect('repaint', area => this._view && drawStopwatch(area, this._view));
        this._label = new St.Label({style_class: 'fermata-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._glyph);
        box.add_child(this._label);
        this.add_child(box);

        this.menu.actor.add_style_class_name('fermata-menu');
        this._card = new TimerCard(controller, () => this.menu.close());
        this.menu.box.add_child(this._card.actor);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._card.update(this._view);
        });
    }

    // Left click opens the card. Right or middle click starts and pauses, which
    // also works as a two-finger tap on a touchpad.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS &&
            [Clutter.BUTTON_SECONDARY, Clutter.BUTTON_MIDDLE].includes(event.get_button())) {
            this.menu.close();
            this._controller.primary();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    update(view) {
        this._view = view;
        this._glyph.queue_repaint();
        this._label.text = view.panelText;
        this._label.visible = view.panelText !== '';
        if (this.menu.isOpen)
            this._card.update(view);
    }
});
