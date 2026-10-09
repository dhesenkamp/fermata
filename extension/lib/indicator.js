// SPDX-License-Identifier: GPL-3.0-or-later
// The top bar button and the card it opens.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {CardSurface} from './card.js';
import {drawStopwatch} from './drawing.js';

/** The card behind a left click: the same shape as the alert, with the time as its title. */
class TimerCard {
    constructor(controller, closeMenu) {
        this._surface = new CardSurface({ring: true});
        this.actor = this._surface.actor;
        this._surface.title.add_style_class_name('fermata-clock');
        this._surface.note.visible = true;

        this._reset = this._surface.cornerButton('view-refresh-symbolic', 'Reset', () => controller.reset());
        this._surface.cornerButton('emblem-system-symbolic', 'Preferences', () => {
            closeMenu();
            controller.openPreferences();
        });

        this._primary = this._surface.addButton(true, () => controller.primary());
        this._extend = this._surface.addButton(false, () => controller.extend());
        this._skip = this._surface.addButton(false, () => controller.skip());
        this._skip.label = 'Skip';
    }

    update(view) {
        const s = this._surface;
        s.setDark(view.dark);
        s.setBadge({color: view.colors.ring, glyph: view.glyph, fraction: view.ringFraction,
            paused: view.state === 'paused'});
        s.title.text = view.timeText;
        s.subtitle.text = view.cardSubtitle;
        s.note.text = view.todayText;
        this._primary.label = view.primaryLabel;
        CardSurface.setFill(this._primary, view.colors.fill);
        this._extend.label = view.state === 'done' ? '5 more min' : '+5 min';
        this._extend.visible = view.state !== 'idle';
        this._skip.visible = view.state !== 'done';
        this._reset.visible = !view.pristine;
    }
}

export const FermataIndicator = GObject.registerClass(
class FermataIndicator extends PanelMenu.Button {
    _init(controller) {
        super._init(0.5, 'Fermata', false);
        this._controller = controller;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box fermata-panel'});
        this._glyph = new St.DrawingArea({style_class: 'fermata-glyph', y_align: Clutter.ActorAlign.CENTER});
        this._glyph.connect('repaint', area => this._view && drawStopwatch(area, this._view.panel));
        this._label = new St.Label({style_class: 'fermata-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._glyph);
        box.add_child(this._label);
        this.add_child(box);

        // The menu only provides opening, closing and focus handling; the card draws itself.
        this.menu.actor.add_style_class_name('fermata-menu');
        this._card = new TimerCard(controller, () => this.menu.close());
        this.menu.box.add_child(this._card.actor);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._card.update(this._view);
            this._repaintAfterAnimation();
        });
        this.connect('destroy', () => {
            if (this._repaintId)
                GLib.Source.remove(this._repaintId);
            this._repaintId = 0;
        });
    }

    // The shell only repaints what it thinks changed while the menu animates, and its
    // idea of the card's area stops short of the soft edge of the shadow.
    _repaintAfterAnimation() {
        if (this._repaintId)
            GLib.Source.remove(this._repaintId);
        this._repaintId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._repaintId = 0;
            global.stage.queue_redraw();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Left click opens the card. Right or middle click starts and pauses, which
    // also works as a two-finger tap on a touchpad.
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
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
