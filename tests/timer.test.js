// Run with: gjs -m tests/timer.test.js
import {Timer, FOCUS, SHORT, LONG, formatClock, formatDuration} from '../extension/lib/timer.js';

let clock = 1000;
const config = {focusMinutes: 30, shortMinutes: 5, longMinutes: 15, longEvery: 4};
let t = new Timer(config, () => clock);

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}
const runOut = () => {
    clock = t.deadline + 0.01;
    return t.tick();
};
const near = (a, b) => Math.abs(a - b) < 0.1;

assert(t.state === 'idle' && t.total === 1800 && t.pristine(), 'starts idle');
t.start();
clock += 60;
assert(near(t.left(), 1740), 'counts down');
t.pause();
clock += 500;
assert(near(t.left(), 1740) && t.state === 'paused', 'pause holds the time');
t.start();
let r = runOut();
assert(r.newSession && r.minutes === 30, 'first session counts 30 minutes');
assert(t.state === 'done' && t.rounds === 1 && t.upcoming() === SHORT, 'then a short break');
clock += 75;
assert(near(t.overtime(), 75), 'overtime counts up');
t.extend(5);
assert(t.state === 'running' && t.total === 2100, 'extend resumes from done');
r = runOut();
assert(!r.newSession && r.minutes === 5, 'an extension credits minutes, not a session');

t.advance(true);
assert(t.phase === SHORT && t.state === 'running' && t.total === 300, 'short break runs');
runOut();
assert(t.upcoming() === FOCUS, 'back to focus after a break');
for (const n of [2, 3]) {
    t.advance(true);
    assert(t.phase === FOCUS && t.roundNow() === n, `round ${n}`);
    runOut();
    t.advance(true);
    assert(t.phase === SHORT, `short break after round ${n}`);
    runOut();
}
t.advance(true);
assert(t.roundNow() === 4 && t.upcoming() === LONG, 'round 4 leads to a long break');
runOut();
t.advance(false);
assert(t.phase === LONG && t.state === 'idle' && t.total === 900, 'long break waits when dismissed');
t.start();
runOut();
t.advance(true);
assert(t.phase === FOCUS && t.rounds === 0 && t.roundNow() === 1, 'a new cycle after the long break');
t.skip();
assert(t.phase === SHORT && t.state === 'running' && t.rounds === 0, "skipping doesn't count");

// Survives being serialised, e.g. across a screen lock.
const saved = t.serialize();
const u = new Timer(config, () => clock);
u.restore(saved);
assert(u.phase === SHORT && u.state === 'running' && near(u.left(), t.left()), 'restores');
clock = u.deadline + 30;
assert(u.tick() !== null && near(u.overtime(), 30), 'a phase that ended while locked shows its overtime');
u.restore('not json');
assert(u.state === 'done', 'ignores garbage');

t.reset();
assert(t.pristine(), 'reset');
config.longMinutes = 0;
assert(t.upcoming() === SHORT, 'long breaks can be turned off');
config.focusMinutes = 25;
t.applyConfig();
assert(t.total === 1500, 'new durations apply when idle');

assert(formatClock(59.2) === '1:00' && formatClock(3725) === '1:02:05' && formatClock(0) === '0:00', 'clock format');
assert(formatDuration(90) === '1 h 30 min' && formatDuration(120) === '2 h' && formatDuration(25) === '25 min',
    'duration format');

print('timer tests passed');
