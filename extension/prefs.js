// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const COUNTDOWN_STYLES = [
    ['mm:ss', 'Minutes and seconds'],
    ['minutes', 'Minutes only'],
    ['hidden', 'Icon only'],
];

export default class FermataPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep it alive as long as the window
        window.set_default_size(460, 720);

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

        const panel = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'Click the timer for the card. Right-click, or tap with two fingers, to start and pause.',
        });
        const countdown = new Adw.ComboRow({
            title: 'Countdown',
            model: Gtk.StringList.new(COUNTDOWN_STYLES.map(([, label]) => label)),
        });
        const syncCountdown = () => {
            countdown.selected = Math.max(0, COUNTDOWN_STYLES.findIndex(([key]) =>
                key === settings.get_string('countdown-style')));
        };
        syncCountdown();
        countdown.connect('notify::selected', () =>
            settings.set_string('countdown-style', COUNTDOWN_STYLES[countdown.selected][0]));
        settings.connect('changed::countdown-style', syncCountdown);
        panel.add(countdown);
        page.add(panel);
    }
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
