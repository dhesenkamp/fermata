#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 Dennis Hesenkamp
"""
Fermata: a calm pomodoro timer for the GNOME top bar.

It talks to the panel directly over D-Bus (StatusNotifierItem + DBusMenu),
so all it needs is python3-gi and GTK 3, which ship with Ubuntu.

    fermata                 start (or open preferences if already running)
    fermata --toggle        start / pause / resume
    fermata --skip          jump to the next phase
    fermata --extend        add five minutes
    fermata --reset         back to round one
    fermata --status        print the current state
    fermata --preview       show what the alert looks like
    fermata --quit
"""

import ctypes
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import wave
from dataclasses import asdict, dataclass, fields
from datetime import date, datetime, timedelta

import gi

# The alert has to float above other windows without taking focus. Wayland
# doesn't let ordinary apps do that, but XWayland does, and GNOME always
# provides it, so use it when we can.
WAYLAND = bool(os.environ.get("WAYLAND_DISPLAY")) or os.environ.get("XDG_SESSION_TYPE") == "wayland"
if WAYLAND and os.environ.get("DISPLAY"):
    os.environ.setdefault("GDK_BACKEND", "x11")

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango  # noqa: E402

try:  # loaded early so Gdk windows are wrapped with get_xid()
    gi.require_version("GdkX11", "3.0")
    from gi.repository import GdkX11  # noqa: E402
except (ValueError, ImportError):
    GdkX11 = None

NAME = "Fermata"
VERSION = "0.1.0"
APP_ID = "io.github.dhesenkamp.Fermata"
APP_PATH = "/" + APP_ID.replace(".", "/")
HERE = os.path.dirname(os.path.realpath(__file__))
STATE_HOME = GLib.get_user_state_dir() if hasattr(GLib, "get_user_state_dir") else os.path.expanduser("~/.local/state")
CONFIG_PATH = os.path.join(GLib.get_user_config_dir(), "fermata", "config.json")
STATS_PATH = os.path.join(STATE_HOME, "fermata", "stats.json")
CACHE_DIR = os.path.join(GLib.get_user_cache_dir(), "fermata")

FOCUS, SHORT, LONG = "focus", "short", "long"
PHASE_NAME = {FOCUS: "Focus", SHORT: "Short break", LONG: "Long break"}

# Ubuntu orange for focus, a calm green and blue for the breaks.
ACCENT = {FOCUS: "#E95420", SHORT: "#2EC27E", LONG: "#3584E4"}
# Tints for the tray ring, tuned for the dark top bar.
PANEL_TINT = {FOCUS: "#FFFFFF", SHORT: "#8FF0A4", LONG: "#99C1F1"}
# Brighter accents for the "time's up" dot in the top bar.
PANEL_ALERT = {FOCUS: "#FF7A45", SHORT: "#57E389", LONG: "#62A0EA"}

PRESETS = [(25, 5), (30, 5), (45, 10), (50, 10)]
EXTEND_MIN = 5


def hex_rgb(color):
    color = color.lstrip("#")
    return tuple(int(color[i:i + 2], 16) / 255 for i in (0, 2, 4))


def fmt_clock(seconds):
    seconds = max(0, int(math.ceil(seconds)))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def fmt_duration(minutes):
    minutes = int(round(minutes))
    if minutes < 60:
        return f"{minutes} min"
    hours, rest = divmod(minutes, 60)
    return f"{hours} h {rest} min" if rest else f"{hours} h"


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


# ── Settings & stats ────────────────────────────────────────────────────────

@dataclass
class Config:
    focus_min: int = 30
    short_min: int = 5
    long_min: int = 15
    long_every: int = 4
    auto_start_breaks: bool = False
    auto_start_focus: bool = False
    sound: bool = True
    glow: bool = True
    remind_every_min: int = 2
    label: str = "mm:ss"  # "mm:ss" | "min" | "off"

    @classmethod
    def load(cls):
        cfg = cls()
        try:
            with open(CONFIG_PATH) as f:
                data = json.load(f)
        except (OSError, ValueError):
            return cfg
        for fld in fields(cls):
            value = data.get(fld.name)
            if type(value) is type(getattr(cfg, fld.name)):
                setattr(cfg, fld.name, value)
        return cfg

    def save(self):
        write_atomic(CONFIG_PATH, asdict(self))


class Stats:
    """Focus sessions and minutes for today."""

    def __init__(self):
        self.day, self.sessions, self.minutes = date.today().isoformat(), 0, 0.0
        try:
            with open(STATS_PATH) as f:
                data = json.load(f)
            if data.get("day") == self.day:
                self.sessions, self.minutes = int(data["sessions"]), float(data["minutes"])
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def _roll(self):
        today = date.today().isoformat()
        if today != self.day:
            self.day, self.sessions, self.minutes = today, 0, 0.0

    def add(self, session, minutes):
        self._roll()
        self.sessions += int(session)
        self.minutes += minutes
        write_atomic(STATS_PATH, {"day": self.day, "sessions": self.sessions, "minutes": self.minutes})

    def summary(self):
        self._roll()
        if not self.sessions:
            return "nothing yet today"
        return f"{fmt_duration(self.minutes)} today"


# ── Timer state machine ─────────────────────────────────────────────────────

class Timer:
    """Phases and states. Deadlines are wall-clock, so time asleep counts as time passed."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.phase = FOCUS
        self.state = "idle"  # idle | running | paused | done
        self.total = self.remaining = self.length(FOCUS)  # seconds, incl. extensions
        self.deadline = self.ended_at = 0.0
        self.rounds = 0  # focus sessions finished in this cycle
        self.counted = False  # this focus phase already counted as a session
        self.credited = 0  # seconds of this phase already added to the stats

    def length(self, phase):
        return 60 * {FOCUS: self.cfg.focus_min, SHORT: self.cfg.short_min, LONG: self.cfg.long_min}[phase]

    def left(self):
        if self.state == "running":
            return max(0.0, self.deadline - time.time())
        return 0.0 if self.state == "done" else self.remaining

    def overtime(self):
        return max(0.0, time.time() - self.ended_at) if self.state == "done" else 0.0

    def fraction_left(self):
        return self.left() / self.total if self.total else 0.0

    def round_now(self):
        return self.rounds + (1 if self.phase == FOCUS and not self.counted else 0)

    def upcoming(self):
        if self.phase != FOCUS:
            return FOCUS
        every = self.cfg.long_every
        if self.cfg.long_min > 0 and every > 0 and max(1, self.round_now()) % every == 0:
            return LONG
        return SHORT

    def pristine(self):
        return self.state == "idle" and self.phase == FOCUS and self.rounds == 0 and self.remaining == self.total

    def _begin(self, phase, run):
        if self.phase == LONG and phase == FOCUS:
            self.rounds = 0
        self.phase, self.counted, self.credited = phase, False, 0
        self.total = self.remaining = self.length(phase)
        self.state = "idle"
        if run:
            self.start()

    def start(self):
        if self.state in ("idle", "paused"):
            self.deadline = time.time() + self.remaining
            self.state = "running"

    def pause(self):
        if self.state == "running":
            self.remaining = self.left()
            self.state = "paused"

    def advance(self, run):
        self._begin(self.upcoming(), run)

    def skip(self):
        self.advance(run=self.state == "running")

    def extend(self, minutes=EXTEND_MIN):
        extra = 60 * minutes
        self.total += extra
        if self.state == "running":
            self.deadline += extra
        elif self.state == "done":
            self.deadline = time.time() + extra
            self.state = "running"
        else:
            self.remaining += extra

    def reset(self):
        self.rounds, self.phase = 0, FOCUS
        self._begin(FOCUS, run=False)

    def apply_config(self):
        if self.state == "idle":
            self.total = self.remaining = self.length(self.phase)

    def tick(self):
        """Returns (new_session, minutes_to_credit) when the phase just ran out, else None."""
        if self.state != "running" or time.time() < self.deadline:
            return None
        self.state, self.ended_at = "done", self.deadline
        if self.phase != FOCUS:
            return False, 0.0
        new_session = not self.counted
        if new_session:
            self.rounds += 1
            self.counted = True
        minutes = (self.total - self.credited) / 60
        self.credited = self.total
        return new_session, minutes


# ── Top bar icons ───────────────────────────────────────────────────────────

class TrayIcons:
    """Stopwatch glyphs rendered to SVG on demand. The ring empties clockwise."""

    STEPS = 60
    REV = 1
    CX, CY, R, W = 8.0, 8.9, 5.4, 1.9

    def __init__(self):
        self.directory = os.path.join(CACHE_DIR, f"icons-v{self.REV}")
        shutil.rmtree(os.path.join(CACHE_DIR, f"icons-v{self.REV - 1}"), ignore_errors=True)
        os.makedirs(self.directory, exist_ok=True)

    def ring(self, phase, fraction, paused=False):
        step = max(0, min(self.STEPS, round(fraction * self.STEPS)))
        name = f"{phase}-{'paused' if paused else 'run'}-{step:02d}"
        return self._file(name, lambda: self._ring_svg(PANEL_TINT[phase], step / self.STEPS, paused))

    def done(self, upcoming):
        return self._file(f"done-{upcoming}", lambda: self._done_svg(PANEL_ALERT[upcoming]))

    def _file(self, name, render):
        path = os.path.join(self.directory, f"fermata-{name}.svg")
        if not os.path.exists(path):
            with open(path, "w") as f:
                f.write(render())
        return path

    def _nub(self, color, opacity=1.0):
        return (f'<rect x="6.4" y="0.55" width="3.2" height="1.75" rx="0.8" '
                f'fill="{color}" fill-opacity="{opacity}"/>')

    def _ring_svg(self, color, fraction, paused):
        cx, cy, r, w = self.CX, self.CY, self.R, self.W
        strong = 0.6 if paused else 1.0
        parts = [
            self._nub(color, strong),
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{color}" '
            f'stroke-opacity="0.3" stroke-width="{w}"/>',
        ]
        stroke = f'fill="none" stroke="{color}" stroke-opacity="{strong}" stroke-width="{w}"'
        if fraction >= 0.999:
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" {stroke}/>')
        elif fraction > 0:
            angle = 2 * math.pi * (1 - fraction)
            x0, y0 = cx + r * math.sin(angle), cy - r * math.cos(angle)
            large = 1 if fraction > 0.5 else 0
            parts.append(f'<path d="M{x0:.3f} {y0:.3f} A{r} {r} 0 {large} 1 {cx} {cy - r:.3f}" '
                         f'{stroke} stroke-linecap="round"/>')
        if paused:
            for x in (6.35, 8.45):
                parts.append(f'<rect x="{x}" y="7.1" width="1.2" height="3.6" rx="0.5" fill="{color}"/>')
        return self._svg(parts)

    def _done_svg(self, color):
        cx, cy = self.CX, self.CY
        return self._svg([
            self._nub(color),
            f'<circle cx="{cx}" cy="{cy}" r="{self.R + self.W / 2}" fill="{color}"/>',
            f'<circle cx="{cx}" cy="{cy}" r="1.7" fill="#ffffff"/>',
        ])

    @staticmethod
    def _svg(parts):
        return ('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">'
                + "".join(parts) + "</svg>")


# ── D-Bus: StatusNotifierItem + DBusMenu ────────────────────────────────────

SNI_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"
WATCHER = "org.kde.StatusNotifierWatcher"

SNI_XML = """
<node><interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="WindowId" type="i" access="read"/>
  <property name="IconThemePath" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="OverlayIconName" type="s" access="read"/>
  <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionIconName" type="s" access="read"/>
  <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionMovieName" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <property name="XAyatanaLabel" type="s" access="read"/>
  <property name="XAyatanaLabelGuide" type="s" access="read"/>
  <property name="XAyatanaOrderingIndex" type="u" access="read"/>
  <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="XAyatanaSecondaryActivate"><arg type="u" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="NewTitle"/>
  <signal name="NewIcon"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg type="s"/></signal>
  <signal name="XAyatanaNewLabel"><arg type="s"/><arg type="s"/></signal>
</interface></node>
"""
# No Activate method on purpose: the GNOME AppIndicator extension then opens
# the menu on the first click instead of waiting to rule out a double-click.

MENU_XML = """
<node><interface name="com.canonical.dbusmenu">
  <property name="Version" type="u" access="read"/>
  <property name="TextDirection" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconThemePath" type="as" access="read"/>
  <method name="GetLayout">
    <arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/>
    <arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/>
  </method>
  <method name="GetGroupProperties">
    <arg type="ai" direction="in"/><arg type="as" direction="in"/>
    <arg type="a(ia{sv})" direction="out"/>
  </method>
  <method name="GetProperty">
    <arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/>
  </method>
  <method name="Event">
    <arg type="i" direction="in"/><arg type="s" direction="in"/>
    <arg type="v" direction="in"/><arg type="u" direction="in"/>
  </method>
  <method name="EventGroup">
    <arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/>
  </method>
  <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
  <method name="AboutToShowGroup">
    <arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/>
  </method>
  <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})"/><arg type="a(ias)"/></signal>
  <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
  <signal name="ItemActivationRequested"><arg type="i"/><arg type="u"/></signal>
</interface></node>
"""


def variant(value):
    if isinstance(value, bool):
        return GLib.Variant("b", value)
    if isinstance(value, int):
        return GLib.Variant("i", value)
    return GLib.Variant("s", value)


class DBusService:
    """Exports one interface. Property reads are answered from a callable."""

    def __init__(self, conn, path, xml, props, methods):
        self.conn, self.path = conn, path
        self.info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
        self.props, self.methods = props, methods
        # With no get_property handler, GDBus routes org.freedesktop.DBus.Properties
        # calls to the method handler, which keeps all of this in one place.
        self.reg_id = conn.register_object(path, self.info, self._on_call, None, None)

    def _on_call(self, conn, sender, path, iface, method, params, invocation):
        try:
            args = params.unpack()
            if iface == "org.freedesktop.DBus.Properties":
                props = self.props()
                if method == "Get" and args[1] in props:
                    invocation.return_value(GLib.Variant("(v)", (props[args[1]],)))
                elif method == "GetAll":
                    invocation.return_value(GLib.Variant("(a{sv})", (props,)))
                else:
                    invocation.return_dbus_error("org.freedesktop.DBus.Error.InvalidArgs", "No such property")
                return
            handler = self.methods.get(method)
            invocation.return_value(handler(*args) if handler else None)
        except Exception as exc:  # never leave the caller hanging
            invocation.return_dbus_error("org.freedesktop.DBus.Error.Failed", str(exc))

    def emit(self, signal, signature=None, *args):
        body = GLib.Variant(signature, args) if signature else None
        self.conn.emit_signal(None, self.path, self.info.name, signal, body)

    def close(self):
        self.conn.unregister_object(self.reg_id)


class DBusMenu:
    def __init__(self, conn, on_click):
        self.on_click = on_click
        self.items = {0: {"children-display": "submenu"}}
        self.children = {0: []}
        self.pending = {}
        self.service = DBusService(conn, MENU_PATH, MENU_XML, self._props, {
            "GetLayout": self._get_layout,
            "GetGroupProperties": self._get_group_properties,
            "GetProperty": lambda i, name: GLib.Variant("(v)", (variant(self.items[i][name]),)),
            "Event": self._event,
            "EventGroup": self._event_group,
            "AboutToShow": lambda i: GLib.Variant("(b)", (False,)),
            "AboutToShowGroup": lambda ids: GLib.Variant("(aiai)", ([], [])),
        })

    def add(self, item_id, props, parent=0):
        self.items[item_id] = dict(props)
        self.children[parent].append(item_id)
        if props.get("children-display") == "submenu":
            self.children[item_id] = []

    def update(self, item_id, props):
        current = self.items[item_id]
        changed = {k: v for k, v in props.items() if current.get(k) != v}
        if changed:
            current.update(changed)
            self.pending.setdefault(item_id, {}).update(changed)

    def flush(self):
        if not self.pending:
            return
        updated = [(i, {k: variant(v) for k, v in p.items()}) for i, p in self.pending.items()]
        self.pending = {}
        self.service.emit("ItemsPropertiesUpdated", "(a(ia{sv})a(ias))", updated, [])

    def _props(self):
        return {
            "Version": GLib.Variant("u", 3),
            "TextDirection": GLib.Variant("s", "ltr"),
            "Status": GLib.Variant("s", "normal"),
            "IconThemePath": GLib.Variant("as", []),
        }

    def _variants(self, item_id, names):
        return {k: variant(v) for k, v in self.items[item_id].items() if not names or k in names}

    def _node(self, item_id, depth, names):
        kids = []
        if depth != 0:
            kids = [GLib.Variant("(ia{sv}av)", self._node(c, depth - 1, names))
                    for c in self.children.get(item_id, [])]
        return item_id, self._variants(item_id, names), kids

    def _get_layout(self, parent, depth, names):
        return GLib.Variant("(u(ia{sv}av))", (1, self._node(parent, depth, names)))

    def _get_group_properties(self, ids, names):
        ids = [i for i in (ids or self.items) if i in self.items]
        return GLib.Variant("(a(ia{sv}))", ([(i, self._variants(i, names)) for i in ids],))

    def _event(self, item_id, event, _data, timestamp):
        if event == "clicked":
            GLib.idle_add(self.on_click, item_id, timestamp)

    def _event_group(self, events):
        for item_id, event, data, timestamp in events:
            self._event(item_id, event, data, timestamp)
        return GLib.Variant("(ai)", ([],))


class Tray:
    def __init__(self, conn, on_click, on_middle_click):
        self.conn = conn
        self.icon, self.label, self.guide = "", "", ""
        self.registered = False
        self.on_registered = None
        self.bus_name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self.menu = DBusMenu(conn, on_click)
        middle = lambda *_: GLib.idle_add(on_middle_click) and None  # noqa: E731
        self.sni = DBusService(conn, SNI_PATH, SNI_XML, self._props, {
            "ContextMenu": lambda x, y: None,
            "SecondaryActivate": middle,
            "XAyatanaSecondaryActivate": middle,
            "Scroll": lambda delta, orientation: None,
        })
        self.own_id = Gio.bus_own_name_on_connection(conn, self.bus_name, Gio.BusNameOwnerFlags.NONE, None, None)
        # Re-register whenever the panel host (re)appears, e.g. after a shell restart.
        self.watch_id = Gio.bus_watch_name_on_connection(
            conn, WATCHER, Gio.BusNameWatcherFlags.NONE, self._register, self._lost)

    def _register(self, conn, _name, _owner):
        conn.call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem",
                  GLib.Variant("(s)", (self.bus_name,)), None, Gio.DBusCallFlags.NONE, -1, None,
                  self._registered)

    def _registered(self, conn, result):
        try:
            conn.call_finish(result)
        except GLib.Error as exc:
            print(f"fermata: the panel refused the tray icon: {exc.message}")
            return
        self.registered = True
        if self.on_registered:
            self.on_registered()

    def _lost(self, *_):
        self.registered = False

    def _props(self):
        empty = GLib.Variant("a(iiay)", [])
        return {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", "fermata"),
            "Title": GLib.Variant("s", NAME),
            "Status": GLib.Variant("s", "Active"),
            "WindowId": GLib.Variant("i", 0),
            "IconThemePath": GLib.Variant("s", os.path.dirname(self.icon)),
            "IconName": GLib.Variant("s", self.icon),
            "IconPixmap": empty,
            "OverlayIconName": GLib.Variant("s", ""),
            "OverlayIconPixmap": empty,
            "AttentionIconName": GLib.Variant("s", ""),
            "AttentionIconPixmap": empty,
            "AttentionMovieName": GLib.Variant("s", ""),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", ("", [], NAME, self.label)),
            "ItemIsMenu": GLib.Variant("b", True),
            "Menu": GLib.Variant("o", MENU_PATH),
            "XAyatanaLabel": GLib.Variant("s", self.label),
            "XAyatanaLabelGuide": GLib.Variant("s", self.guide),
            "XAyatanaOrderingIndex": GLib.Variant("u", 0),
        }

    def set(self, icon, label, guide):
        if icon != self.icon:
            self.icon = icon
            self.sni.emit("NewIcon")
        if (label, guide) != (self.label, self.guide):
            self.label, self.guide = label, guide
            self.sni.emit("XAyatanaNewLabel", "(ss)", label, guide)
        self.menu.flush()

    def close(self):
        Gio.bus_unwatch_name(self.watch_id)
        Gio.bus_unown_name(self.own_id)
        self.sni.close()
        self.menu.service.close()


# ── Sound ───────────────────────────────────────────────────────────────────

class Chimes:
    """A soft bell, synthesised once and cached. Falls back to the system sound theme."""

    REV = 1
    # (start s, frequency Hz, gain)
    NOTES = {
        "rest": ((0.0, 783.99, 0.85), (0.18, 587.33, 1.0)),  # G5 -> D5, settling down
        "focus": ((0.0, 523.25, 0.75), (0.13, 659.25, 0.85), (0.26, 783.99, 1.0)),  # C5 E5 G5, lifting
    }
    # (frequency multiple, gain, decay per second): a warm, marimba-ish bell
    PARTIALS = ((1.0, 1.0, 2.6), (2.0, 0.3, 4.6), (3.0, 0.09, 7.5), (4.16, 0.045, 12.0))
    RATE = 44100

    def __init__(self):
        self.player = next((shutil.which(p) for p in ("pw-play", "paplay", "aplay") if shutil.which(p)), None)
        self.procs = []

    def path(self, kind):
        path = os.path.join(CACHE_DIR, f"chime-{kind}-v{self.REV}.wav")
        if not os.path.exists(path):
            self._render(path, self.NOTES[kind])
        return path

    def play(self, kind):
        self.procs = [p for p in self.procs if p.poll() is None]
        if self.player:
            cmd = [self.player, self.path(kind)]
        elif shutil.which("canberra-gtk-play"):
            cmd = ["canberra-gtk-play", "-i", "complete"]
        else:
            Gdk.beep()
            return
        self.procs.append(subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

    def _render(self, path, notes, length=1.9):
        rate = self.RATE
        n = int(rate * length)
        buf = [0.0] * n
        attack = int(0.005 * rate)
        for start, freq, gain in notes:
            s0 = int(start * rate)
            for mult, amp, decay in self.PARTIALS:
                w = 2 * math.pi * freq * mult / rate
                fall = math.exp(-decay / rate)
                env = gain * amp
                for i in range(n - s0):
                    ramp = i / attack if i < attack else 1.0
                    buf[s0 + i] += env * ramp * math.sin(w * i)
                    env *= fall
                    if env < 1e-4:
                        break
        peak = max(abs(v) for v in buf) or 1.0
        fade = int(0.08 * rate)
        scale = 0.45 * 32767 / peak
        samples = [int(v * scale * (min(1.0, (n - i) / fade))) for i, v in enumerate(buf)]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(struct.pack(f"<{n}h", *samples))


# ── Look & feel ─────────────────────────────────────────────────────────────

PALETTES = {
    "light": dict(bg="#FFFFFF", fg="#1F1F23", dim="rgba(31,31,35,0.6)", border="rgba(0,0,0,0.07)",
                  soft="rgba(0,0,0,0.055)", softer="rgba(0,0,0,0.1)",
                  shadow="0 14px 36px rgba(0,0,0,0.16), 0 2px 6px rgba(0,0,0,0.08)"),
    "dark": dict(bg="#2B2B30", fg="#F3F3F5", dim="rgba(243,243,245,0.6)", border="rgba(255,255,255,0.08)",
                 soft="rgba(255,255,255,0.08)", softer="rgba(255,255,255,0.14)",
                 shadow="0 14px 36px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.3)"),
}

GLOW_DEPTH = 72  # px
GLOW_PEAK = 0.62  # opacity right at the edge
GLOW_FALLOFF = ((0.0, 1.0), (0.1, 0.72), (0.28, 0.4), (0.52, 0.15), (0.78, 0.04), (1.0, 0.0))

BASE_CSS = """
.fermata-heading { font-weight: bold; font-size: 0.92em; color: alpha(@theme_fg_color, 0.62);
                margin: 22px 6px 8px 6px; }
.fermata-heading.first { margin-top: 2px; }
list.fermata-list { background-color: @theme_base_color; border-radius: 12px; padding: 0;
                 border: 1px solid alpha(@theme_fg_color, 0.11); }
list.fermata-list > row { padding: 9px 14px; min-height: 38px; background: transparent;
                       border-bottom: 1px solid alpha(@theme_fg_color, 0.07); }
list.fermata-list > row:last-child { border-bottom-style: none; }
list.fermata-list > row:hover, list.fermata-list > row:selected { background: transparent; }
.fermata-row-title { color: @theme_fg_color; }
.fermata-row-sub { font-size: 0.86em; color: alpha(@theme_fg_color, 0.58); }
.fermata-unit { color: alpha(@theme_fg_color, 0.58); }

window.fermata-popup, window.fermata-popup.background { background-color: transparent; background-image: none; }
.fermata-card { border-radius: 18px; padding: 14px 14px 14px 14px; }
.fermata-badge { border-radius: 999px; min-width: 44px; min-height: 44px; margin: 2px 0 0 0; }
.fermata-title { font-weight: bold; font-size: 15px; }
.fermata-sub { font-size: 12.5px; }
.fermata-overtime { font-size: 12px; margin-right: 2px; }
.fermata-card button { border-radius: 999px; min-height: 0; min-width: 0; padding: 6px 15px;
                    background-image: none; border: none; box-shadow: none; text-shadow: none;
                    -gtk-icon-shadow: none; }
.fermata-card button.fermata-primary { color: #FFFFFF; font-weight: bold; }
.fermata-card button.fermata-close { padding: 3px; }
.fermata-glow { background-repeat: no-repeat; }
"""


def rgba(color, alpha):
    r, g, b = (int(round(c * 255)) for c in hex_rgb(color))
    return f"rgba({r},{g},{b},{alpha:.3f})"


def build_css():
    css = [BASE_CSS]
    d = GLOW_DEPTH
    for phase, accent in ACCENT.items():
        stops = ", ".join(f"{rgba(accent, GLOW_PEAK * k)} {round(off * 100)}%" for off, k in GLOW_FALLOFF)
        css.append(f"""
.fermata-glow.fermata-{phase} {{
  background-image: linear-gradient(to bottom, {stops}), linear-gradient(to top, {stops}),
                    linear-gradient(to right, {stops}), linear-gradient(to left, {stops});
  background-size: 100% {d}px, 100% {d}px, {d}px 100%, {d}px 100%;
  background-position: left top, left bottom, left top, right top;
}}
.fermata-{phase} .fermata-badge {{ background-color: {rgba(accent, 0.13)};
                             animation: fermata-ripple-{phase} 2.6s ease-out infinite; }}
@keyframes fermata-ripple-{phase} {{
  0%   {{ box-shadow: 0 0 0 0 {rgba(accent, 0.42)}; }}
  80%  {{ box-shadow: 0 0 0 11px {rgba(accent, 0)}; }}
  100% {{ box-shadow: 0 0 0 11px {rgba(accent, 0)}; }}
}}
""")
    for mode, p in PALETTES.items():
        sel = f".fermata-popup.{mode} .fermata-card"
        css.append(f"""
{sel} {{ background-color: {p['bg']}; color: {p['fg']}; border: 1px solid {p['border']};
         box-shadow: {p['shadow']}, 0 0 0 0 transparent; }}
{sel} .fermata-sub, {sel} .fermata-overtime {{ color: {p['dim']}; }}
{sel} button.fermata-secondary {{ background-color: {p['soft']}; color: {p['fg']}; }}
{sel} button.fermata-secondary:hover {{ background-color: {p['softer']}; }}
{sel} button.fermata-close {{ background-color: transparent; color: {p['dim']}; }}
{sel} button.fermata-close:hover {{ background-color: {p['soft']}; color: {p['fg']}; }}
""")
        for phase, accent in ACCENT.items():
            name = f"fermata-nudge-{mode}-{phase}"
            css.append(f"""
{sel}.fermata-{phase} button.fermata-primary {{ background-color: {accent}; }}
{sel}.fermata-{phase} button.fermata-primary:hover {{ background-color: shade({accent}, 1.08); }}
{sel}.fermata-{phase} button.fermata-primary:active {{ background-color: shade({accent}, 0.9); }}
@keyframes {name} {{
  from {{ box-shadow: {p['shadow']}, 0 0 0 0 {rgba(accent, 0.55)}; }}
  to   {{ box-shadow: {p['shadow']}, 0 0 0 16px {rgba(accent, 0)}; }}
}}
{sel}.fermata-{phase}.fermata-nudge {{ animation: {name} 1.1s ease-out 3; }}
""")
    return "".join(css)


def install_css():
    provider = Gtk.CssProvider()
    try:
        provider.load_from_data(build_css().encode())
    except GLib.Error as exc:  # a theme quirk should never stop the timer
        print(f"fermata: CSS problem: {exc.message}")
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)


def badge_icon(phase):
    """The stopwatch-with-a-check glyph shown on the alert card."""
    color = ACCENT[phase]
    path = os.path.join(CACHE_DIR, f"badge-{phase}-v1.svg")
    if not os.path.exists(path):
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(path, "w") as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">'
                    f'<rect x="10.4" y="1.2" width="5.2" height="2.8" rx="1.2" fill="{color}"/>'
                    f'<circle cx="13" cy="14.6" r="9.2" fill="none" stroke="{color}" stroke-width="2.4"/>'
                    f'<path d="M9.1 14.9 L11.9 17.6 L17 12.3" fill="none" stroke="{color}" stroke-width="2.3" '
                    f'stroke-linecap="round" stroke-linejoin="round"/></svg>')
    return path


def prefers_dark():
    source = Gio.SettingsSchemaSource.get_default()
    schema = source.lookup("org.gnome.desktop.interface", True) if source else None
    if schema:
        settings = Gio.Settings.new("org.gnome.desktop.interface")
        if schema.has_key("color-scheme") and settings.get_string("color-scheme") == "prefer-dark":
            return True
        return settings.get_string("gtk-theme").lower().endswith("-dark")
    return bool(Gtk.Settings.get_default().props.gtk_application_prefer_dark_theme)


def is_x11():
    return GdkX11 is not None and isinstance(Gdk.Display.get_default(), GdkX11.X11Display)


def pointer_monitor():
    display = Gdk.Display.get_default()
    if WAYLAND:
        # Through XWayland the pointer position is only fresh over X11 windows.
        return display.get_primary_monitor() or display.get_monitor(0)
    try:
        _, x, y = display.get_default_seat().get_pointer().get_position()
        return display.get_monitor_at_point(x, y)
    except Exception:
        return display.get_primary_monitor() or display.get_monitor(0)


class InputShape:
    """Makes overlay windows click-through, via XFixes.

    GTK can do this itself, but only from Python when python3-gi-cairo is
    installed, which it isn't by default on Ubuntu. A few lines of ctypes avoid
    asking for sudo.
    """

    SHAPE_INPUT = 2

    class Rect(ctypes.Structure):
        _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short),
                    ("width", ctypes.c_ushort), ("height", ctypes.c_ushort)]

    def __init__(self):
        self.dpy = None
        if not is_x11():
            return
        try:
            self.x11 = x11 = ctypes.CDLL("libX11.so.6")
            self.xf = xf = ctypes.CDLL("libXfixes.so.3")
            x11.XOpenDisplay.restype = ctypes.c_void_p
            x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
            x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
            xf.XFixesQueryVersion.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
                                              ctypes.POINTER(ctypes.c_int)]
            xf.XFixesCreateRegion.restype = ctypes.c_ulong
            xf.XFixesCreateRegion.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
            xf.XFixesSetWindowShapeRegion.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                                      ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
            xf.XFixesDestroyRegion.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            x11.XInternAtom.restype = ctypes.c_ulong
            x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
            x11.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
                                            ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
            dpy = x11.XOpenDisplay(Gdk.Display.get_default().get_name().encode())
            major, minor = ctypes.c_int(5), ctypes.c_int(0)
            if dpy and xf.XFixesQueryVersion(dpy, ctypes.byref(major), ctypes.byref(minor)) and major.value >= 2:
                self.dpy = dpy
        except (OSError, AttributeError):
            self.dpy = None

    @property
    def available(self):
        return self.dpy is not None

    def keep_composited(self, gdk_window):
        """Ask the compositor never to hand this window straight to the display.

        Otherwise a full-screen overlay at full opacity gets "unredirected", and its
        transparent pixels show up as a black monitor (_NET_WM_BYPASS_COMPOSITOR = 2).
        """
        if not self.dpy or gdk_window is None:
            return
        Gdk.Display.get_default().sync()
        atom = self.x11.XInternAtom(self.dpy, b"_NET_WM_BYPASS_COMPOSITOR", 0)
        value = (ctypes.c_long * 1)(2)
        self.x11.XChangeProperty(self.dpy, gdk_window.get_xid(), atom, 6, 32, 0, value, 1)  # 6 = CARDINAL
        self.x11.XSync(self.dpy, 0)

    def set(self, gdk_window, rects):
        """Only `rects` (x, y, w, h) take pointer input; an empty list makes the window click-through."""
        if not self.dpy or gdk_window is None:
            return False
        Gdk.Display.get_default().sync()  # make sure the X server knows the window first
        array = (self.Rect * max(1, len(rects)))(*(self.Rect(*r) for r in rects))
        region = self.xf.XFixesCreateRegion(self.dpy, array if rects else None, len(rects))
        self.xf.XFixesSetWindowShapeRegion(self.dpy, gdk_window.get_xid(), self.SHAPE_INPUT, 0, 0, region)
        self.xf.XFixesDestroyRegion(self.dpy, region)
        self.x11.XSync(self.dpy, 0)
        return True


_input_shape = None


def input_shape():
    global _input_shape
    if _input_shape is None:
        _input_shape = InputShape()
    return _input_shape


def overlay_window():
    """A transparent, unfocusable window that floats above everything."""
    if is_x11():
        # Override-redirect: never steals keyboard focus, no taskbar entry, stays on top.
        win = Gtk.Window(type=Gtk.WindowType.POPUP)
    else:
        win = Gtk.Window()
        win.set_decorated(False)
        win.set_keep_above(True)
        win.set_accept_focus(False)
        win.set_focus_on_map(False)
        win.set_skip_taskbar_hint(True)
        win.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION)
    screen = win.get_screen()
    visual = screen.get_rgba_visual()
    if visual and screen.is_composited():
        win.set_visual(visual)
    win.get_style_context().add_class("fermata-popup")
    return win


def ease_out(p):
    return 1 - (1 - p) ** 3


# ── The alert ───────────────────────────────────────────────────────────────

class AlertCard:
    """A small card that slides in at the top of the screen and stays until you act on it."""

    WIDTH = 404

    def __init__(self, phase, title, subtitle, primary, secondary, on_primary, on_secondary, on_close,
                 ended_at=None):
        self.phase, self.ended_at = phase, ended_at
        self.closing = False

        self.win = win = overlay_window()
        win.get_style_context().add_class("dark" if prefers_dark() else "light")

        card = self.card = Gtk.Grid(column_spacing=14)
        ctx = card.get_style_context()
        ctx.add_class("fermata-card")
        ctx.add_class(f"fermata-{phase}")
        card.set_size_request(self.WIDTH, -1)
        # Room for the drop shadow and the nudge ring, outside the card itself.
        card.set_margin_top(20)
        card.set_margin_bottom(36)
        card.set_margin_start(30)
        card.set_margin_end(30)

        # The badge's ripple is a CSS animation: movement in the corner of your eye, not a flashing light.
        badge = Gtk.Box(valign=Gtk.Align.START, halign=Gtk.Align.CENTER)
        badge.get_style_context().add_class("fermata-badge")
        icon = Gio.FileIcon.new(Gio.File.new_for_path(badge_icon(phase)))
        image = Gtk.Image.new_from_gicon(icon, Gtk.IconSize.DIALOG)
        image.set_pixel_size(26)
        badge.pack_start(image, True, True, 0)
        card.attach(badge, 0, 0, 1, 3)

        title_label = Gtk.Label(label=title, xalign=0, hexpand=True, margin_top=4)
        title_label.get_style_context().add_class("fermata-title")
        card.attach(title_label, 1, 0, 1, 1)

        corner = Gtk.Box(spacing=4, valign=Gtk.Align.START)
        self.overtime = Gtk.Label(valign=Gtk.Align.CENTER)
        self.overtime.get_style_context().add_class("fermata-overtime")
        corner.pack_start(self.overtime, False, False, 0)
        close = Gtk.Button(relief=Gtk.ReliefStyle.NONE, can_focus=False, tooltip_text="Dismiss")
        close.set_image(Gtk.Image.new_from_icon_name("window-close-symbolic", Gtk.IconSize.MENU))
        close.get_style_context().add_class("fermata-close")
        close.connect("clicked", lambda *_: on_close())
        corner.pack_start(close, False, False, 0)
        card.attach(corner, 2, 0, 1, 1)

        sub_label = Gtk.Label(label=subtitle, xalign=0, ellipsize=Pango.EllipsizeMode.END, margin_top=1)
        sub_label.get_style_context().add_class("fermata-sub")
        card.attach(sub_label, 1, 1, 2, 1)

        buttons = Gtk.Box(spacing=8, margin_top=12)
        for text, cls, callback in ((primary, "fermata-primary", on_primary),
                                    (secondary, "fermata-secondary", on_secondary)):
            if not text:
                continue
            button = Gtk.Button(label=text, can_focus=False)
            button.get_style_context().add_class(cls)
            button.connect("clicked", lambda *_, cb=callback: cb())
            buttons.pack_start(button, False, False, 0)
        card.attach(buttons, 1, 2, 2, 1)

        win.add(card)
        # Only the card itself takes clicks; the shadow margin stays click-through.
        card.connect("size-allocate", lambda *_: self._shape())
        win.connect("realize", lambda *_: self._shape())
        self.update()

    def _shape(self):
        a = self.card.get_allocation()
        if a.width > 1:
            input_shape().set(self.win.get_window(), [(a.x, a.y, a.width, a.height)])

    def present(self):
        win = self.win
        win.get_child().show_all()
        _, natural = win.get_preferred_size()
        area = pointer_monitor().get_workarea()
        self.x = area.x + (area.width - natural.width) // 2
        self.y = area.y - 8  # the card's own top margin leaves a 12 px gap below the bar
        win.move(self.x, self.y - 18)
        Gtk.Widget.set_opacity(win, 0)
        win.show_all()
        self._animate(0.32, (-18, 0), (0, 1))

    def _animate(self, duration, frm, to, done=None):
        start = time.monotonic()

        def step(*_):
            p = min(1.0, (time.monotonic() - start) / duration)
            e = ease_out(p)
            self.win.move(self.x, int(round(self.y + frm[0] + (to[0] - frm[0]) * e)))
            Gtk.Widget.set_opacity(self.win, frm[1] + (to[1] - frm[1]) * e)
            if p >= 1:
                if done:
                    GLib.idle_add(done)
                return False
            return True

        self.win.add_tick_callback(step)

    def update(self):
        if self.ended_at is None:
            self.overtime.set_text("")
        else:
            gone = fmt_clock(max(0.0, time.time() - self.ended_at))
            self.overtime.set_markup(f'<span font_features="tnum">+{gone}</span>')

    def nudge(self):
        ctx = self.card.get_style_context()
        ctx.remove_class("fermata-nudge")
        GLib.idle_add(ctx.add_class, "fermata-nudge")

    def close(self):
        if self.closing:
            return
        self.closing = True
        self._animate(0.2, (0, 1), (-10, 0), self.win.destroy)


class EdgeGlow:
    """A soft, click-through glow that pulses around every screen edge a few times, then fades."""

    PULSES = ((0.0, 1.0), (1.35, 0.8), (2.7, 0.6))  # (start s, strength)
    DURATION = 4.4

    def __init__(self, phase):
        shapes = input_shape()
        if not shapes.available:
            return  # never risk an overlay that swallows clicks
        self.t0 = time.monotonic()
        display = Gdk.Display.get_default()
        for i in range(display.get_n_monitors()):
            mon = display.get_monitor(i)
            geo, area = mon.get_geometry(), mon.get_workarea()
            win = overlay_window()
            win.move(geo.x, geo.y)
            # One pixel short of the monitor: compositors treat an exactly monitor-sized
            # window as full-screen and may stop compositing it, which blacks out the screen.
            win.set_size_request(geo.width, geo.height - 1)
            glow = Gtk.Box()
            glow.get_style_context().add_class("fermata-glow")
            glow.get_style_context().add_class(f"fermata-{phase}")
            # Glow inside the work area so it isn't hidden under the top bar or dock.
            glow.set_margin_start(area.x - geo.x)
            glow.set_margin_top(area.y - geo.y)
            glow.set_margin_end(geo.x + geo.width - area.x - area.width)
            glow.set_margin_bottom(max(0, geo.y + geo.height - area.y - area.height - 1))
            win.add(glow)
            win.connect("realize", lambda w: (shapes.keep_composited(w.get_window()),
                                              shapes.set(w.get_window(), [])))
            Gtk.Widget.set_opacity(win, 0)
            win.show_all()
            # Fading the whole window leaves the work to the compositor: GTK paints the gradients once.
            win.add_tick_callback(self._tick)

    def level(self):
        t = time.monotonic() - self.t0
        value = 0.0
        for start, strength in self.PULSES:
            u = t - start
            if u >= 0:
                value += strength * (u / 0.22 if u < 0.22 else math.exp(-(u - 0.22) / 0.5))
        return min(1.0, value)

    def _tick(self, win, _clock):
        if time.monotonic() - self.t0 > self.DURATION:
            GLib.idle_add(win.destroy)
            return False
        Gtk.Widget.set_opacity(win, self.level())
        return True


# ── Preferences ─────────────────────────────────────────────────────────────

class Preferences(Gtk.Window):
    def __init__(self, app):
        super().__init__(application=app, title=NAME)
        self.app = app
        self.set_resizable(False)
        self.set_default_size(440, -1)
        self.set_position(Gtk.WindowPosition.CENTER)

        header = Gtk.HeaderBar(show_close_button=True, title=NAME)
        stats = app.stats
        header.set_subtitle(f"{stats.sessions} session{'s' if stats.sessions != 1 else ''} · {stats.summary()}"
                            if stats.sessions else "Nothing focused yet today")
        self.set_titlebar(header)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        for side in ("start", "end", "bottom"):
            getattr(box, f"set_margin_{side}")(22)
        box.set_margin_top(18)
        self.add(box)

        box.add(self._heading("Timer", first=True))
        box.add(self._list([
            self._spin("Focus", None, "focus_min", 1, 180, "min"),
            self._spin("Short break", None, "short_min", 1, 60, "min"),
            self._spin("Long break", "Set to 0 to skip long breaks", "long_min", 0, 90, "min"),
            self._spin("Long break after", None, "long_every", 1, 12, "rounds"),
            self._switch("Start breaks automatically", None, "auto_start_breaks"),
            self._switch("Start focus automatically", None, "auto_start_focus"),
        ]))

        box.add(self._heading("When time is up"))
        preview = Gtk.Button(label="Preview", valign=Gtk.Align.CENTER)
        preview.connect("clicked", lambda *_: app.preview_alert())
        box.add(self._list([
            self._switch("Chime", "A soft bell, different for breaks and focus", "sound"),
            self._switch("Screen glow", "The screen edges pulse a few times", "glow"),
            self._spin("Remind again every", "Until you respond. 0 = only once", "remind_every_min", 0, 30, "min"),
            self._row("Try it", "Shows the alert without touching the timer", preview),
        ]))

        box.add(self._heading("Top bar"))
        combo = Gtk.ComboBoxText(valign=Gtk.Align.CENTER)
        for key, text in (("mm:ss", "Minutes and seconds"), ("min", "Minutes only"), ("off", "Icon only")):
            combo.append(key, text)
        combo.set_active_id(app.cfg.label)
        combo.connect("changed", lambda c: self._set("label", c.get_active_id()))
        box.add(self._list([self._row("Countdown", "Middle-click the icon to start or pause", combo)]))

        self.show_all()

    def _set(self, key, value):
        setattr(self.app.cfg, key, value)
        self.app.config_changed()

    @staticmethod
    def _heading(text, first=False):
        label = Gtk.Label(label=text, xalign=0)
        label.get_style_context().add_class("fermata-heading")
        if first:
            label.get_style_context().add_class("first")
        return label

    @staticmethod
    def _list(rows):
        listbox = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        listbox.get_style_context().add_class("fermata-list")
        for row in rows:
            listbox.add(row)
        return listbox

    @staticmethod
    def _row(title, subtitle, *controls):
        row = Gtk.ListBoxRow(activatable=False, selectable=False)
        hbox = Gtk.Box(spacing=10)
        texts = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, valign=Gtk.Align.CENTER, spacing=1)
        title_label = Gtk.Label(label=title, xalign=0)
        title_label.get_style_context().add_class("fermata-row-title")
        texts.add(title_label)
        if subtitle:
            sub = Gtk.Label(label=subtitle, xalign=0)
            sub.get_style_context().add_class("fermata-row-sub")
            texts.add(sub)
        hbox.pack_start(texts, True, True, 0)
        for control in controls:
            hbox.pack_start(control, False, False, 0)
        row.add(hbox)
        return row

    def _spin(self, title, subtitle, key, lo, hi, unit):
        spin = Gtk.SpinButton.new_with_range(lo, hi, 1)
        spin.set_value(getattr(self.app.cfg, key))
        spin.set_numeric(True)
        spin.set_valign(Gtk.Align.CENTER)
        spin.connect("value-changed", lambda s: self._set(key, int(s.get_value())))
        unit_label = Gtk.Label(label=unit, width_chars=6, xalign=0)
        unit_label.get_style_context().add_class("fermata-unit")
        return self._row(title, subtitle, spin, unit_label)

    def _switch(self, title, subtitle, key):
        switch = Gtk.Switch(active=getattr(self.app.cfg, key), valign=Gtk.Align.CENTER)
        switch.connect("notify::active", lambda s, _p: self._set(key, s.get_active()))
        return self._row(title, subtitle, switch)


class TrayHelp(Gtk.MessageDialog):
    """Shown when nothing in the top bar picked up the icon, usually a disabled extension."""

    def __init__(self, app):
        super().__init__(message_type=Gtk.MessageType.INFO, buttons=Gtk.ButtonsType.NONE,
                         text=f"{NAME} needs the AppIndicator extension", secondary_use_markup=True)
        self.app = app
        self.set_title(NAME)
        self.uuid = self._installed_extension()
        if self.uuid:
            body = ("The timer is running, but the top bar has nowhere to show it. "
                    "Turn on the AppIndicator extension and the icon appears straight away.")
        else:
            body = ("The timer is running, but the top bar has nowhere to show it. Install "
                    '<a href="https://extensions.gnome.org/extension/615/appindicator-support/">'
                    "AppIndicator and KStatusNotifierItem Support</a> and the icon appears straight away.")
        self.format_secondary_markup(body)
        self.add_button("Quit", 1)
        if self.uuid:
            self.add_button("Turn it on", 2)
            self.set_default_response(2)
        else:
            self.add_button("OK", Gtk.ResponseType.CLOSE)
        self.connect("response", self._on_response)
        # It appears on its own a few seconds after login, so focus-stealing
        # prevention would otherwise leave it hidden behind other windows.
        self.set_keep_above(True)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.present()

    @staticmethod
    def _installed_extension():
        roots = [os.path.join(GLib.get_user_data_dir(), "gnome-shell", "extensions")]
        roots += [os.path.join(d, "gnome-shell", "extensions") for d in GLib.get_system_data_dirs()]
        for uuid in APPINDICATOR_EXTENSIONS:
            if shutil.which("gnome-extensions") and any(os.path.isdir(os.path.join(r, uuid)) for r in roots):
                return uuid
        return None

    def _on_response(self, _dialog, response):
        if response == 2:
            subprocess.Popen(["gnome-extensions", "enable", self.uuid])
        elif response == 1:
            self.app.shutdown_app()
        self.destroy()
        self.app.tray_help = None


# ── Application ─────────────────────────────────────────────────────────────

M_STATUS, M_ROUND, M_SEP1, M_PRIMARY, M_EXTEND, M_SKIP, M_RESET, M_SEP2, M_DURATIONS, M_PREFS, M_QUIT = range(1, 12)
M_PRESET, M_CUSTOM = 100, 120

OPTIONS = (
    ("toggle", "Start, pause or resume the timer"),
    ("skip", "Skip to the next phase"),
    ("extend", f"Add {EXTEND_MIN} minutes"),
    ("reset", "Reset to the first round"),
    ("preferences", "Open preferences"),
    ("preview", "Preview the alert"),
    ("status", "Print the current state"),
    ("quit", "Quit the running timer"),
    ("version", "Print the version"),
)

STATUS_XML = """
<node><interface name="io.github.dhesenkamp.Fermata.Timer">
  <method name="Status"><arg type="s" direction="out"/></method>
</interface></node>
"""

# The extensions that let GNOME Shell show tray icons, Ubuntu's first.
APPINDICATOR_EXTENSIONS = ("ubuntu-appindicators@ubuntu.com", "appindicatorsupport@rgcjonas.gmail.com")


class FermataApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        for name, description in OPTIONS:
            self.add_main_option(name, 0, GLib.OptionFlags.NONE, GLib.OptionArg.NONE, description, None)
        self.card = self.prefs = self.tray_help = None
        self.last_nudge = 0.0

    def do_handle_local_options(self, options):
        """Answer the read-only options here, without starting a timer."""
        opts = {name for name, _ in OPTIONS if options.contains(name)}
        if "version" in opts:
            print(f"{NAME} {VERSION}")
            return 0
        if "status" in opts or "quit" in opts:
            status = self._ask_running_instance()
            if "status" in opts:
                print(status or "Not running")
                return 0 if status else 1
            if status is None:
                return 0  # nothing to quit
        return -1

    def _ask_running_instance(self):
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            reply = bus.call_sync(APP_ID, APP_PATH + "/Timer", "io.github.dhesenkamp.Fermata.Timer", "Status",
                                  None, GLib.VariantType("(s)"), Gio.DBusCallFlags.NO_AUTO_START, 2000, None)
            return reply.unpack()[0]
        except GLib.Error:
            return None

    # lifecycle

    def do_startup(self):
        Gtk.Application.do_startup(self)
        self.hold()
        self.cfg = Config.load()
        self.stats = Stats()
        self.timer = Timer(self.cfg)
        self.icons = TrayIcons()
        self.chimes = Chimes()
        install_css()
        icon = os.path.join(HERE, "data", f"{APP_ID}.svg")
        if Gtk.IconTheme.get_default().has_icon(APP_ID):
            Gtk.Window.set_default_icon_name(APP_ID)
        elif os.path.exists(icon):
            try:
                Gtk.Window.set_default_icon_from_file(icon)
            except GLib.Error:
                pass
        conn = self.get_dbus_connection()
        self.status_service = DBusService(conn, APP_PATH + "/Timer", STATUS_XML, dict,
                                          {"Status": lambda: GLib.Variant("(s)", (self.status_text(),))})
        self.tray = Tray(conn, self.on_menu, self.primary)
        self.tray.on_registered = self._close_tray_help
        self._build_menu()
        self.refresh()
        GLib.timeout_add(250, self._tick)
        GLib.timeout_add_seconds(6, self._check_tray)
        # Render the chimes ahead of time so the first alert isn't delayed.
        GLib.idle_add(lambda: [self.chimes.path(k) for k in Chimes.NOTES] and False)

    def do_command_line(self, command_line):
        options = command_line.get_options_dict()
        opts = {name for name, _ in OPTIONS if options.contains(name)}
        actions = {"toggle": self.primary, "skip": self.skip, "extend": self.extend, "reset": self.reset,
                   "preferences": self.show_preferences, "preview": self.preview_alert, "quit": self.shutdown_app}
        for name, action in actions.items():
            if name in opts:
                action()
        if not opts and command_line.get_is_remote():
            self.show_preferences()  # launched again from the app grid
        return 0

    def shutdown_app(self):
        if self.card:
            self.card.close()
        self.status_service.close()
        self.tray.close()
        self.release()
        self.quit()

    # no tray host

    def _check_tray(self):
        if not self.tray.registered:
            self.tray_help = TrayHelp(self)
        return False

    def _close_tray_help(self):
        if self.tray_help:
            self.tray_help.destroy()
            self.tray_help = None

    # timer actions

    def primary(self):
        if self.timer.state == "done":
            self.start_next()
        elif self.timer.state == "running":
            self.timer.pause()
        else:
            self.timer.start()
        self.refresh()

    def start_next(self):
        self.close_card()
        self.timer.advance(run=True)
        self.refresh()

    def extend(self):
        self.close_card()
        self.timer.extend()
        self.refresh()

    def skip(self):
        self.close_card()
        self.timer.skip()
        self.refresh()

    def reset(self):
        self.close_card()
        self.timer.reset()
        self.refresh()

    def dismiss(self):
        self.close_card()
        if self.timer.state == "done":
            self.timer.advance(run=False)
        self.refresh()

    def config_changed(self):
        self.cfg.save()
        self.timer.apply_config()
        self.refresh()

    def _tick(self):
        result = self.timer.tick()
        if result is not None:
            new_session, minutes = result
            if self.timer.phase == FOCUS:
                self.stats.add(new_session, minutes)
            self._finished()
        elif self.timer.state == "done" and self.cfg.remind_every_min > 0:
            if time.time() - self.last_nudge >= 60 * self.cfg.remind_every_min:
                self.nudge(self.timer.upcoming())
        if self.card:
            self.card.update()
        self.refresh()
        return True

    # alerts

    def _finished(self):
        t, cfg = self.timer, self.cfg
        finished, upcoming = t.phase, t.upcoming()
        auto = cfg.auto_start_breaks if finished == FOCUS else cfg.auto_start_focus
        minutes = round(t.total / 60)
        break_len = cfg.long_min if upcoming == LONG else cfg.short_min

        if auto:
            t.advance(run=True)
            ends = (datetime.now() + timedelta(seconds=t.total)).strftime("%H:%M")
            title = "Focus started" if upcoming == FOCUS else f"{PHASE_NAME[upcoming]} started"
            self.show_card(upcoming, title, f"{fmt_duration(t.total / 60)} · until {ends}",
                           "Got it", "Skip", self.close_card, self.skip, self.close_card, None)
            GLib.timeout_add_seconds(20, lambda card=self.card: card is self.card and self.close_card())
        elif finished == FOCUS:
            if cfg.long_min > 0:
                progress = f"round {min(t.rounds, cfg.long_every)} of {cfg.long_every}"
            else:
                progress = f"{self.stats.sessions} today"
            title = "Time for a long break" if upcoming == LONG else "Time for a break"
            self.show_card(upcoming, title, f"{minutes} min of focus done · {progress}",
                           f"Start {break_len} min break", f"{EXTEND_MIN} more min",
                           self.start_next, self.extend, self.dismiss, t.ended_at)
        else:
            self.show_card(upcoming, "Back to focus", f"Break's over · next up: {cfg.focus_min} min",
                           "Start focus", f"{EXTEND_MIN} more min",
                           self.start_next, self.extend, self.dismiss, t.ended_at)
        self.nudge(upcoming, card=False)

    def show_card(self, phase, title, subtitle, primary, secondary, on_primary, on_secondary, on_close, ended_at):
        self.close_card()
        self.card = AlertCard(phase, title, subtitle, primary, secondary,
                              on_primary, on_secondary, on_close, ended_at)
        self.card.present()

    def close_card(self):
        if self.card:
            self.card.close()
            self.card = None

    def nudge(self, upcoming, card=True):
        self.last_nudge = time.time()
        if self.cfg.sound:
            self.chimes.play("focus" if upcoming == FOCUS else "rest")
        if self.cfg.glow and is_x11():
            EdgeGlow(upcoming)
        if card and self.card:
            self.card.nudge()

    def preview_alert(self):
        if self.timer.state == "done":
            self.nudge(self.timer.upcoming())
            return
        self.show_card(SHORT, "Time for a break", f"{self.cfg.focus_min} min of focus done · this is a preview",
                       f"Start {self.cfg.short_min} min break", f"{EXTEND_MIN} more min",
                       self.close_card, self.close_card, self.close_card, time.time())
        self.nudge(SHORT, card=False)

    def show_preferences(self, timestamp=0):
        if self.prefs is None:
            self.prefs = Preferences(self)
            self.prefs.connect("destroy", lambda *_: setattr(self, "prefs", None))
        if timestamp:
            self.prefs.present_with_time(timestamp)
        else:
            self.prefs.present()

    # top bar

    def status_text(self):
        t = self.timer
        name = PHASE_NAME[t.phase]
        if t.state == "running":
            return f"{name} · {fmt_clock(t.left())} left"
        if t.state == "paused":
            return f"{name} paused · {fmt_clock(t.left())} left"
        if t.state == "done":
            return f"{name} complete · {fmt_clock(t.overtime())} ago"
        return f"Ready · {fmt_duration(t.total / 60)} {name.lower()}"

    def _build_menu(self):
        menu = self.tray.menu
        info = {"enabled": False}
        menu.add(M_STATUS, {"label": "", **info})
        menu.add(M_ROUND, {"label": "", **info})
        menu.add(M_SEP1, {"type": "separator"})
        menu.add(M_PRIMARY, {"label": ""})
        menu.add(M_EXTEND, {"label": f"Add {EXTEND_MIN} minutes"})
        menu.add(M_SKIP, {"label": ""})
        menu.add(M_RESET, {"label": "Reset"})
        menu.add(M_SEP2, {"type": "separator"})
        menu.add(M_DURATIONS, {"label": "", "children-display": "submenu"})
        for i, (focus, short) in enumerate(PRESETS):
            menu.add(M_PRESET + i, {"label": f"{focus} / {short}", "toggle-type": "radio", "toggle-state": 0},
                     parent=M_DURATIONS)
        menu.add(M_CUSTOM, {"label": "Custom…", "toggle-type": "radio", "toggle-state": 0}, parent=M_DURATIONS)
        menu.add(M_PREFS, {"label": "Preferences…"})
        menu.add(M_QUIT, {"label": "Quit"})

    def refresh(self):
        t, cfg = self.timer, self.cfg

        if t.state == "done":
            icon = self.icons.done(t.upcoming())
        else:
            icon = self.icons.ring(t.phase, t.fraction_left(), paused=t.state == "paused")

        label, guide = "", ""
        if cfg.label != "off":
            if t.state == "done":
                label, guide = f"+{fmt_clock(t.overtime())}", "+00:00"
            elif t.state in ("running", "paused"):
                if cfg.label == "min":
                    label, guide = f"{math.ceil(t.left() / 60)}m", "00m"
                else:
                    label, guide = fmt_clock(t.left()), "00:00"

        menu = self.tray.menu
        menu.update(M_STATUS, {"label": self.status_text()})
        parts = []
        if cfg.long_min > 0:
            parts.append(f"Round {min(max(1, t.round_now()), cfg.long_every)} of {cfg.long_every}")
        parts.append(self.stats.summary())
        line = " · ".join(parts)
        menu.update(M_ROUND, {"label": line[0].upper() + line[1:]})

        if t.state == "done":
            primary = "Start focus" if t.upcoming() == FOCUS else "Start break"
        elif t.state == "running":
            primary = "Pause"
        elif t.state == "paused":
            primary = "Resume"
        else:
            primary = "Start focus" if t.phase == FOCUS else f"Start {PHASE_NAME[t.phase].lower()}"
        menu.update(M_PRIMARY, {"label": primary})
        menu.update(M_EXTEND, {"visible": t.state != "idle"})
        menu.update(M_SKIP, {"label": "Skip to break" if t.phase == FOCUS else "Skip to focus",
                             "visible": t.state != "done"})
        menu.update(M_RESET, {"visible": not t.pristine()})

        current = (cfg.focus_min, cfg.short_min)
        menu.update(M_DURATIONS, {"label": f"Durations · {cfg.focus_min} / {cfg.short_min}"})
        for i, preset in enumerate(PRESETS):
            menu.update(M_PRESET + i, {"toggle-state": int(preset == current)})
        menu.update(M_CUSTOM, {"toggle-state": int(current not in PRESETS)})

        self.tray.set(icon, label, guide)

    def on_menu(self, item_id, timestamp):
        if item_id == M_PRIMARY:
            self.primary()
        elif item_id == M_EXTEND:
            self.extend()
        elif item_id == M_SKIP:
            self.skip()
        elif item_id == M_RESET:
            self.reset()
        elif M_PRESET <= item_id < M_PRESET + len(PRESETS):
            self.cfg.focus_min, self.cfg.short_min = PRESETS[item_id - M_PRESET]
            self.config_changed()
        elif item_id in (M_CUSTOM, M_PREFS):
            self.show_preferences(timestamp)
        elif item_id == M_QUIT:
            self.shutdown_app()


def main():
    GLib.set_prgname("fermata")
    GLib.set_application_name(NAME)
    return FermataApp().run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
