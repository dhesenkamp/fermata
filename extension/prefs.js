// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PALETTE_CHOICES = [
    ['dusk', 'Dusk', 'Iris, teal and lavender'],
    ['ubuntu', 'Ubuntu', 'Orange, green and blue'],
    ['pomodoro', 'Pomodoro', 'Tomato, basil and olive'],
    ['stone', 'Stone', 'Slate, sage and mist'],
];

const COUNTDOWN_STYLES = [
    ['mm:ss', 'Minutes and seconds'],
    ['minutes', 'Minutes only'],
    ['hidden', 'Icon only'],
];

export default class FermataPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep it alive as long as the window
        window.set_default_size(460, 980);

        const page = new Adw.PreferencesPage();
        window.add(page);

        const timer = new Adw.PreferencesGroup({title: 'Timer', description: 'All durations are in minutes.'});
        timer.add(spinRow(settings, 'focus-minutes', 'Focus', null, 1, 180));
        timer.add(spinRow(settings, 'short-break-minutes', 'Short break', null, 1, 60));
        timer.add(spinRow(settings, 'long-break-minutes', 'Long break', 'Set to 0 to skip long breaks', 0, 90));
        timer.add(spinRow(settings, 'long-break-every', 'Long break after', 'Focus rounds', 1, 12));
        timer.add(switchRow(settings, 'auto-start-breaks', 'Start breaks automatically'));
        timer.add(switchRow(settings, 'auto-start-focus', 'Start focus automatically'));
        page.add(timer);

        const alerts = new Adw.PreferencesGroup({title: 'When time is up'});
        alerts.add(switchRow(settings, 'chime', 'Chime',
            'A soft bell, rising before focus and falling before a break'));
        alerts.add(switchRow(settings, 'glow', 'Screen glow', 'The screen edges pulse softly a few times'));
        alerts.add(spinRow(settings, 'remind-every-minutes', 'Remind again every',
            'Minutes, until you respond. 0 means only once', 0, 30));
        const preview = new Gtk.Button({label: 'Preview', valign: Gtk.Align.CENTER});
        preview.connect('clicked', () => settings.set_int('preview', (settings.get_int('preview') + 1) % 1000));
        const tryIt = new Adw.ActionRow({title: 'Try it', subtitle: "Shows the alert without touching the timer"});
        tryIt.add_suffix(preview);
        alerts.add(tryIt);
        page.add(alerts);

        const look = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Click the timer for the card. Right-click, or tap with two fingers, to start and pause.',
        });
        look.add(choiceRow(settings, 'palette', 'Colours', PALETTE_CHOICES));
        look.add(choiceRow(settings, 'countdown-style', 'Countdown in the top bar', COUNTDOWN_STYLES));
        page.add(look);
    }
}

/** A drop-down for a string key; `choices` is a list of [value, label, subtitle?]. */
function choiceRow(settings, key, title, choices) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices.map(([, label]) => label))});
    const sync = () => {
        const index = Math.max(0, choices.findIndex(([value]) => value === settings.get_string(key)));
        if (row.selected !== index)
            row.selected = index;
        row.subtitle = choices[index][2] ?? '';
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper) {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title});
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}
