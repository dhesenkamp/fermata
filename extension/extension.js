// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Dennis Hesenkamp
// Fermata: a calm pomodoro timer for the GNOME top bar, with breaks you can't miss.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlertCard, EdgeGlow} from './lib/alert.js';
import {FermataIndicator} from './lib/indicator.js';
import {PALETTES, phaseColors} from './lib/palette.js';
import {FOCUS, LONG, PHASE_NAME, Timer, formatClock, formatDuration} from './lib/timer.js';

const EXTEND_MINUTES = 5;
const DBUS_PATH = '/io/github/dhesenkamp/Fermata';
const DBUS_XML = `
<node><interface name="io.github.dhesenkamp.Fermata">
  <method name="Toggle"/>
  <method name="Skip"/>
  <method name="Extend"/>
  <method name="Reset"/>
  <method name="Preview"/>
  <method name="Open"/>
  <method name="Dismiss"/>
  <method name="Status"><arg type="s" direction="out" name="status"/></method>
</interface></node>`;

/** Focus sessions and minutes for today, kept in GSettings. */
class Stats {
    constructor(settings) {
        this._settings = settings;
        let saved = {};
        try {
            saved = JSON.parse(settings.get_string('stats')) ?? {};
        } catch {}
        this.day = saved.day;
        this.sessions = saved.sessions ?? 0;
        this.minutes = saved.minutes ?? 0;
        this._roll();
    }

    _roll() {
        const today = GLib.DateTime.new_now_local().format('%F');
        if (this.day !== today)
            Object.assign(this, {day: today, sessions: 0, minutes: 0});
    }

    add(newSession, minutes) {
        this._roll();
        this.sessions += newSession ? 1 : 0;
        this.minutes += minutes;
        const {day, sessions} = this;
        this._settings.set_string('stats', JSON.stringify({day, sessions, minutes: this.minutes}));
    }

    summary() {
        this._roll();
        if (!this.sessions)
            return 'Nothing focused yet today';
        return `${formatDuration(this.minutes)} today · ${this.sessions} session${this.sessions === 1 ? '' : 's'}`;
    }
}

export default class FermataExtension extends Extension {
    enable() {
        const settings = this._settings = this.getSettings();
        const config = {
            get focusMinutes() {
                return settings.get_int('focus-minutes');
            },
            get shortMinutes() {
                return settings.get_int('short-break-minutes');
            },
            get longMinutes() {
                return settings.get_int('long-break-minutes');
            },
            get longEvery() {
                return settings.get_int('long-break-every');
            },
        };
        this._timer = new Timer(config);
        // GNOME turns extensions off while the screen is locked, so the timer lives on in GSettings.
        this._timer.restore(settings.get_string('timer-state'));
        this._stats = new Stats(settings);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._alert = null;
        this._glow = null;
        this._tickId = 0;
        this._autoCloseId = 0;
        this._lastNudge = 0;

        this._indicator = new FermataIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        settings.connectObject(
            'changed::focus-minutes', () => this._configChanged(),
            'changed::short-break-minutes', () => this._configChanged(),
            'changed::long-break-minutes', () => this._configChanged(),
            'changed::long-break-every', () => this._configChanged(),
            'changed::countdown-style', () => this._refresh(),
            'changed::palette', () => this._refresh(),
            'changed::preview', () => this.preview(),
            this);
        this._interface.connectObject('changed::color-scheme', () => this._refresh(), this);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, {
            Toggle: () => this.primary(),
            Skip: () => this.skip(),
            Extend: () => this.extend(),
            Reset: () => this.reset(),
            Preview: () => this.preview(),
            Open: () => this._indicator.menu.toggle(),
            Dismiss: () => this.dismiss(),
            Status: () => this._statusText(),
        });
        this._dbus.export(Gio.DBus.session, DBUS_PATH);

        if (this._timer.state === 'done') {
            // It ran out before the screen was locked: bring the card back, quietly.
            this._lastNudge = Date.now() / 1000;
            this._showAlert(this._timer.phase, this._timer.upcoming());
        }
        this._tick();
    }

    disable() {
        this._save();
        if (this._tickId)
            GLib.Source.remove(this._tickId);
        if (this._autoCloseId)
            GLib.Source.remove(this._autoCloseId);
        this._tickId = this._autoCloseId = 0;
        this._alert?.destroy();
        this._glow?.destroy();
        this._alert = this._glow = null;
        this._dbus.unexport();
        this._dbus = null;
        this._settings.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._indicator.destroy();
        this._indicator = null;
        this._settings = this._interface = this._timer = this._stats = null;
    }

    // ── actions ──────────────────────────────────────────────────────────

    primary() {
        const t = this._timer;
        if (t.state === 'done')
            return this.startNext();
        if (t.state === 'running')
            t.pause();
        else
            t.start();
        this._changed();
    }

    startNext() {
        this._closeAlert();
        this._timer.advance(true);
        this._changed();
    }

    extend() {
        this._closeAlert();
        this._timer.extend(EXTEND_MINUTES);
        this._changed();
    }

    skip() {
        this._closeAlert();
        this._timer.skip();
        this._changed();
    }

    reset() {
        this._closeAlert();
        this._timer.reset();
        this._changed();
    }

    dismiss() {
        this._closeAlert();
        if (this._timer.state === 'done')
            this._timer.advance(false);
        this._changed();
    }

    preview() {
        if (this._timer.state === 'done') {
            this._nudge(this._timer.upcoming());
            return;
        }
        const minutes = this._settings.get_int('focus-minutes');
        const breakMinutes = this._settings.get_int('short-break-minutes');
        this._openAlert({
            phase: 'short',
            title: 'Time for a break',
            subtitle: `${minutes} min of focus done · this is a preview`,
            primary: `Start ${breakMinutes} min break`,
            secondary: `${EXTEND_MINUTES} more min`,
            onPrimary: () => this._closeAlert(),
            onSecondary: () => this._closeAlert(),
            onClose: () => this._closeAlert(),
            endedAt: Date.now() / 1000,
        });
        this._nudge('short', false);
    }

    // ── timing ───────────────────────────────────────────────────────────

    _changed() {
        this._save();
        this._refresh();
        this._schedule();
    }

    _configChanged() {
        this._timer.applyConfig();
        this._changed();
    }

    _save() {
        this._settings.set_string('timer-state', this._timer.serialize());
    }

    _tick() {
        this._tickId = 0;
        const t = this._timer;
        const result = t.tick();
        if (result) {
            if (t.phase === FOCUS)
                this._stats.add(result.newSession, result.minutes);
            this._save();
            this._finished();
        } else if (t.state === 'done') {
            const every = this._settings.get_int('remind-every-minutes');
            if (every > 0 && Date.now() / 1000 - this._lastNudge >= 60 * every)
                this._nudge(t.upcoming());
        }
        this._alert?.update();
        this._refresh();
        this._schedule();
        return GLib.SOURCE_REMOVE;
    }

    /** Wake up exactly when the displayed second changes, and not at all while idle or paused. */
    _schedule() {
        if (this._tickId)
            GLib.Source.remove(this._tickId);
        this._tickId = 0;
        const t = this._timer;
        let seconds;
        if (t.state === 'running')
            seconds = t.left() % 1 || 1;
        else if (t.state === 'done')
            seconds = 1 - t.overtime() % 1;
        else
            return;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(seconds * 1000) + 10, () => this._tick());
    }

    // ── alerts ───────────────────────────────────────────────────────────

    _finished() {
        const t = this._timer;
        const finished = t.phase;
        const upcoming = t.upcoming();
        const auto = this._settings.get_boolean(finished === FOCUS ? 'auto-start-breaks' : 'auto-start-focus');
        if (auto) {
            t.advance(true);
            this._save();
            const ends = GLib.DateTime.new_now_local().add_seconds(t.total).format('%H:%M');
            const card = this._openAlert({
                phase: upcoming,
                title: upcoming === FOCUS ? 'Focus started' : `${PHASE_NAME[upcoming]} started`,
                subtitle: `${formatDuration(t.total / 60)} · until ${ends}`,
                primary: 'Got it',
                secondary: 'Skip',
                onPrimary: () => this._closeAlert(),
                onSecondary: () => this.skip(),
                onClose: () => this._closeAlert(),
                endedAt: null,
            });
            // Nothing to decide here, so the card leaves by itself.
            this._autoCloseId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
                this._autoCloseId = 0;
                if (this._alert === card)
                    this._closeAlert();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._showAlert(finished, upcoming);
        }
        this._nudge(upcoming, false);
    }

    _showAlert(finished, upcoming) {
        const t = this._timer;
        const s = this._settings;
        let copy;
        if (finished === FOCUS) {
            const breakMinutes = s.get_int(upcoming === LONG ? 'long-break-minutes' : 'short-break-minutes');
            const progress = t.longBreaksOn()
                ? `round ${Math.min(t.rounds, s.get_int('long-break-every'))} of ${s.get_int('long-break-every')}`
                : `${this._stats.sessions} today`;
            copy = {
                title: upcoming === LONG ? 'Time for a long break' : 'Time for a break',
                subtitle: `${Math.round(t.total / 60)} min of focus done · ${progress}`,
                primary: `Start ${breakMinutes} min break`,
            };
        } else {
            copy = {
                title: 'Back to focus',
                subtitle: `Break's over · next up: ${s.get_int('focus-minutes')} min`,
                primary: 'Start focus',
            };
        }
        this._openAlert({
            ...copy,
            phase: upcoming,
            secondary: `${EXTEND_MINUTES} more min`,
            onPrimary: () => this.startNext(),
            onSecondary: () => this.extend(),
            onClose: () => this.dismiss(),
            endedAt: t.endedAt,
        });
    }

    _dark() {
        return this._interface.get_string('color-scheme') === 'prefer-dark' ||
            this._interface.get_string('gtk-theme').toLowerCase().endsWith('-dark');
    }

    _colors(phase, dark = this._dark()) {
        return phaseColors(this._settings.get_string('palette'), phase, dark);
    }

    _openAlert(params) {
        this._closeAlert();
        const dark = this._dark();
        this._alert = new AlertCard({...params, dark, colors: this._colors(params.phase, dark)});
        this._alert.show();
        return this._alert;
    }

    _closeAlert() {
        if (this._autoCloseId)
            GLib.Source.remove(this._autoCloseId);
        this._autoCloseId = 0;
        this._alert?.close();
        this._alert = null;
    }

    /** Chime and glow, in the colour of what comes next. */
    _nudge(upcoming, swellCard = true) {
        this._lastNudge = Date.now() / 1000;
        if (this._settings.get_boolean('chime')) {
            const file = this.dir.get_child('sounds').get_child(upcoming === FOCUS ? 'focus.wav' : 'rest.wav');
            global.display.get_sound_player().play_from_file(file, 'Fermata', null);
        }
        if (this._settings.get_boolean('glow')) {
            this._glow?.destroy();
            this._glow = new EdgeGlow(this._colors(upcoming).vivid, () => (this._glow = null));
        }
        if (swellCard)
            this._alert?.nudge();
    }

    // ── what the top bar and the card show ──────────────────────────────

    _statusText() {
        const t = this._timer;
        const name = PHASE_NAME[t.phase];
        switch (t.state) {
        case 'running':
            return `${name} · ${formatClock(t.left())} left`;
        case 'paused':
            return `${name} paused · ${formatClock(t.left())} left`;
        case 'done':
            return `${name} complete · ${formatClock(t.overtime())} ago`;
        default:
            return `Ready · ${formatDuration(t.total / 60)} ${name.toLowerCase()}`;
        }
    }

    _refresh() {
        const t = this._timer;
        const s = this._settings;
        const upcoming = t.upcoming();
        const done = t.state === 'done';
        const accentPhase = done ? upcoming : t.phase;
        const dark = this._dark();
        const palette = PALETTES[s.get_string('palette')] ?? PALETTES.dusk;

        const style = s.get_string('countdown-style');
        let panelText = '';
        if (style !== 'hidden' && t.state !== 'idle') {
            if (done)
                panelText = `+${formatClock(t.overtime())}`;
            else
                panelText = style === 'minutes' ? `${Math.ceil(t.left() / 60)}m` : formatClock(t.left());
        }

        const breakMinutes = s.get_int(upcoming === LONG ? 'long-break-minutes' : 'short-break-minutes');
        let primaryLabel;
        if (done)
            primaryLabel = upcoming === FOCUS ? 'Start focus' : `Start ${breakMinutes} min break`;
        else if (t.state === 'running')
            primaryLabel = 'Pause';
        else if (t.state === 'paused')
            primaryLabel = 'Resume';
        else
            primaryLabel = t.phase === FOCUS ? 'Start focus' : 'Start break';

        const every = s.get_int('long-break-every');
        const round = t.longBreaksOn() ? `round ${Math.min(Math.max(1, t.roundNow()), every)} of ${every}` : '';
        const until = GLib.DateTime.new_now_local().add_seconds(t.left()).format('%H:%M');
        const name = PHASE_NAME[t.phase];
        let cardSubtitle;
        if (done)
            cardSubtitle = t.phase === FOCUS ? 'Focus done · time for a break' : "Break's over · back to focus";
        else if (t.state === 'paused')
            cardSubtitle = ['Paused', round].filter(Boolean).join(' · ');
        else if (t.state === 'idle')
            cardSubtitle = [t.phase === FOCUS ? 'Ready to focus' : `${name}, ready`, round].filter(Boolean).join(' · ');
        else if (t.phase === FOCUS)
            cardSubtitle = ['Focus', round, `until ${until}`].filter(Boolean).join(' · ');
        else
            cardSubtitle = `${name} · back at ${until}`;

        let glyph = t.phase === FOCUS ? 'stopwatch' : 'cup';
        if (done)
            glyph = 'check';
        else if (t.state === 'paused')
            glyph = 'pause';

        this._indicator.update({
            state: t.state,
            dark,
            colors: this._colors(accentPhase, dark),
            glyph,
            ringFraction: done || t.state === 'idle' ? 1 : t.fractionLeft(),
            pristine: t.pristine(),
            panelText,
            panel: {
                state: t.state,
                fraction: t.fractionLeft(),
                tint: t.phase === FOCUS ? null : palette[t.phase].vivid,
                dot: palette[upcoming].vivid,
            },
            timeText: done ? `+${formatClock(t.overtime())}` : formatClock(t.left()),
            cardSubtitle,
            primaryLabel,
            todayText: this._stats.summary(),
        });
    }
}
