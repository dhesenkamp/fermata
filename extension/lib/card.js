// SPDX-License-Identifier: GPL-3.0-or-later
// The card shape shared by the time's-up alert and the card behind the top bar button,
// so the two always look like one family.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {drawBadge} from './drawing.js';
import {shade} from './palette.js';

export class CardSurface {
    /** `ring`: a larger badge with a progress ring round it. */
    constructor({ring = false} = {}) {
        this.actor = new St.BoxLayout({style_class: 'fermata-surface', reactive: true});

        this.badgeBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: ring ? 'fermata-badge-box fermata-badge-ring' : 'fermata-badge-box',
            y_align: Clutter.ActorAlign.START,
        });
        this.badge = new St.DrawingArea({x_expand: true, y_expand: true});
        this.badge.connect('repaint', area => this._badge && drawBadge(area, this._badge));
        this.badgeBox.add_child(this.badge);
        this.actor.add_child(this.badgeBox);

        const column = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'fermata-surface-text'});
        const header = new St.BoxLayout();
        this.title = new St.Label({style_class: 'fermata-surface-title', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this.corner = new St.BoxLayout({style_class: 'fermata-corner', y_align: Clutter.ActorAlign.START});
        header.add_child(this.title);
        header.add_child(this.corner);
        column.add_child(header);
        this.subtitle = new St.Label({style_class: 'fermata-surface-subtitle'});
        column.add_child(this.subtitle);
        this.note = new St.Label({style_class: 'fermata-surface-note', visible: false});
        column.add_child(this.note);
        this.buttons = new St.BoxLayout({style_class: 'fermata-surface-buttons'});
        column.add_child(this.buttons);
        this.actor.add_child(column);
    }

    setDark(dark) {
        if (this._dark === dark)
            return;
        this._dark = dark;
        this.actor.remove_style_class_name(dark ? 'fermata-light' : 'fermata-dark');
        this.actor.add_style_class_name(dark ? 'fermata-dark' : 'fermata-light');
    }

    /** {color, glyph, fraction?, paused?}, see drawBadge(). */
    setBadge(badge) {
        this._badge = badge;
        this.badge.queue_repaint();
    }

    /** A small round icon button in the top-right corner, like the alert's close button. */
    cornerButton(iconName, accessibleName, onClick) {
        const button = new St.Button({
            style_class: 'fermata-corner-button',
            icon_name: iconName,
            accessible_name: accessibleName,
            can_focus: true,
        });
        button.connect('clicked', () => onClick());
        this.corner.add_child(button);
        return button;
    }

    /** A pill button. Primary ones take their colour from setFill(). */
    addButton(primary, onClick) {
        const button = new St.Button({
            style_class: `fermata-button ${primary ? 'fermata-primary' : 'fermata-secondary'}`,
            can_focus: true,
        });
        button.connect('clicked', () => onClick());
        if (primary) {
            const paint = () => {
                if (!button._fill)
                    return;
                const color = button.pressed ? shade(button._fill, -0.12)
                    : button.hover ? shade(button._fill, 0.1) : button._fill;
                button.set_style(`background-color: ${color};`);
            };
            button._paint = paint;
            button.connect('notify::hover', paint);
            button.connect('notify::pressed', paint);
        }
        this.buttons.add_child(button);
        return button;
    }

    static setFill(button, fill) {
        if (button._fill === fill)
            return;
        button._fill = fill;
        button._paint();
    }
}
