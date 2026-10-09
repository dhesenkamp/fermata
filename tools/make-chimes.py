#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthesises the two chimes in extension/sounds/. Run it again after changing the notes."""

import math
import os
import struct
import wave

RATE = 44100
LENGTH = 1.9  # seconds
# (start s, frequency Hz, gain)
NOTES = {
    "rest": ((0.0, 783.99, 0.85), (0.18, 587.33, 1.0)),  # G5 -> D5, settling down before a break
    "focus": ((0.0, 523.25, 0.75), (0.13, 659.25, 0.85), (0.26, 783.99, 1.0)),  # C5 E5 G5, lifting
}
# (frequency multiple, gain, decay per second): a warm, marimba-ish bell
PARTIALS = ((1.0, 1.0, 2.6), (2.0, 0.3, 4.6), (3.0, 0.09, 7.5), (4.16, 0.045, 12.0))


def render(path, notes):
    n = int(RATE * LENGTH)
    buf = [0.0] * n
    attack = int(0.005 * RATE)
    for start, freq, gain in notes:
        s0 = int(start * RATE)
        for mult, amp, decay in PARTIALS:
            w = 2 * math.pi * freq * mult / RATE
            fall = math.exp(-decay / RATE)
            env = gain * amp
            for i in range(n - s0):
                ramp = i / attack if i < attack else 1.0
                buf[s0 + i] += env * ramp * math.sin(w * i)
                env *= fall
                if env < 1e-4:
                    break
    peak = max(abs(v) for v in buf) or 1.0
    fade = int(0.08 * RATE)
    scale = 0.45 * 32767 / peak
    samples = [int(v * scale * min(1.0, (n - i) / fade)) for i, v in enumerate(buf)]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(struct.pack(f"<{n}h", *samples))


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "sounds")
    os.makedirs(out, exist_ok=True)
    for name, notes in NOTES.items():
        render(os.path.join(out, f"{name}.wav"), notes)
        print(f"wrote sounds/{name}.wav")
