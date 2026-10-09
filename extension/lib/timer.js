// SPDX-License-Identifier: GPL-3.0-or-later
// The pomodoro state machine. Plain JavaScript, so it can be tested outside GNOME Shell.

export const FOCUS = 'focus';
export const SHORT = 'short';
export const LONG = 'long';

export const PHASE_NAME = {[FOCUS]: 'Focus', [SHORT]: 'Short break', [LONG]: 'Long break'};

const wallClock = () => Date.now() / 1000;

/**
 * Phases and states. Deadlines are wall-clock seconds, so time spent asleep or
 * locked counts as time passed.
 *
 * `config` is read live: {focusMinutes, shortMinutes, longMinutes, longEvery}.
 */
export class Timer {
    constructor(config, now = wallClock) {
        this.config = config;
        this.now = now;
        this.phase = FOCUS;
        this.state = 'idle'; // idle | running | paused | done
        this.total = this.remaining = this.length(FOCUS); // seconds, incl. extensions
        this.deadline = this.endedAt = 0;
        this.rounds = 0; // focus sessions finished in this cycle
        this.counted = false; // this focus phase already counted as a session
        this.credited = 0; // seconds of this phase already added to the stats
    }

    length(phase) {
        const {focusMinutes, shortMinutes, longMinutes} = this.config;
        return 60 * {[FOCUS]: focusMinutes, [SHORT]: shortMinutes, [LONG]: longMinutes}[phase];
    }

    left() {
        if (this.state === 'running')
            return Math.max(0, this.deadline - this.now());
        return this.state === 'done' ? 0 : this.remaining;
    }

    overtime() {
        return this.state === 'done' ? Math.max(0, this.now() - this.endedAt) : 0;
    }

    fractionLeft() {
        return this.total ? this.left() / this.total : 0;
    }

    roundNow() {
        return this.rounds + (this.phase === FOCUS && !this.counted ? 1 : 0);
    }

    longBreaksOn() {
        return this.config.longMinutes > 0 && this.config.longEvery > 0;
    }

    upcoming() {
        if (this.phase !== FOCUS)
            return FOCUS;
        if (this.longBreaksOn() && Math.max(1, this.roundNow()) % this.config.longEvery === 0)
            return LONG;
        return SHORT;
    }

    pristine() {
        return this.state === 'idle' && this.phase === FOCUS && this.rounds === 0 &&
            this.remaining === this.total;
    }

    _begin(phase, run) {
        if (this.phase === LONG && phase === FOCUS)
            this.rounds = 0;
        this.phase = phase;
        this.counted = false;
        this.credited = 0;
        this.total = this.remaining = this.length(phase);
        this.state = 'idle';
        if (run)
            this.start();
    }

    start() {
        if (this.state === 'idle' || this.state === 'paused') {
            this.deadline = this.now() + this.remaining;
            this.state = 'running';
        }
    }

    pause() {
        if (this.state === 'running') {
            this.remaining = this.left();
            this.state = 'paused';
        }
    }

    advance(run) {
        this._begin(this.upcoming(), run);
    }

    skip() {
        this.advance(this.state === 'running');
    }

    extend(minutes) {
        const extra = 60 * minutes;
        this.total += extra;
        if (this.state === 'running') {
            this.deadline += extra;
        } else if (this.state === 'done') {
            this.deadline = this.now() + extra;
            this.state = 'running';
        } else {
            this.remaining += extra;
        }
    }

    reset() {
        this.rounds = 0;
        this.phase = FOCUS;
        this._begin(FOCUS, false);
    }

    applyConfig() {
        if (this.state === 'idle')
            this.total = this.remaining = this.length(this.phase);
    }

    /** Returns {newSession, minutes} when the phase just ran out, otherwise null. */
    tick() {
        if (this.state !== 'running' || this.now() < this.deadline)
            return null;
        this.state = 'done';
        this.endedAt = this.deadline;
        if (this.phase !== FOCUS)
            return {newSession: false, minutes: 0};
        const newSession = !this.counted;
        if (newSession) {
            this.rounds += 1;
            this.counted = true;
        }
        const minutes = (this.total - this.credited) / 60;
        this.credited = this.total;
        return {newSession, minutes};
    }

    serialize() {
        const {phase, state, total, remaining, deadline, endedAt, rounds, counted, credited} = this;
        return JSON.stringify({phase, state, total, remaining, deadline, endedAt, rounds, counted, credited});
    }

    restore(json) {
        let saved;
        try {
            saved = JSON.parse(json);
        } catch {
            return;
        }
        if (!saved || ![FOCUS, SHORT, LONG].includes(saved.phase) ||
            !['idle', 'running', 'paused', 'done'].includes(saved.state))
            return;
        Object.assign(this, saved);
    }
}

export function formatClock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatDuration(minutes) {
    const m = Math.round(minutes);
    if (m < 60)
        return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
