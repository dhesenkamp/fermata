#!/usr/bin/env bash
# Installs Fermata for the current user. No sudo needed.
#
#   ./install.sh                 install, start now and at every login
#   ./install.sh --no-autostart  install without the login entry
#   ./install.sh --uninstall     remove it again (your settings stay)
set -euo pipefail

app_id="io.github.dhesenkamp.Fermata"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
bin="$HOME/.local/bin/fermata"
icon="$data/icons/hicolor/scalable/apps/$app_id.svg"
launcher="$data/applications/$app_id.desktop"
autostart="$config/autostart/$app_id.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
    [[ -x "$bin" ]] && "$bin" --quit || true
    rm -f "$bin" "$icon" "$launcher" "$autostart"
    echo "Fermata removed. Your settings are still in $config/fermata."
    exit 0
fi

missing=()
/usr/bin/python3 -c 'import gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk' 2>/dev/null \
    || missing+=(python3-gi gir1.2-gtk-3.0)
if (( ${#missing[@]} )); then
    echo "Fermata needs GTK 3 for Python. Install it with:"
    echo "    sudo apt install ${missing[*]}"
    exit 1
fi

[[ -x "$bin" ]] && "$bin" --quit 2>/dev/null || true  # replace a running older copy
install -Dm755 "$here/fermata.py" "$bin"
install -Dm644 "$here/data/$app_id.svg" "$icon"

mkdir -p "$(dirname "$launcher")"
cat > "$launcher" <<EOF
[Desktop Entry]
Type=Application
Name=Fermata
Comment=A calm pomodoro timer for the top bar
Exec=$bin
Icon=$app_id
Categories=Utility;GTK;
Keywords=pomodoro;timer;focus;break;
StartupNotify=false
Actions=toggle;preferences;

[Desktop Action toggle]
Name=Start or Pause
Exec=$bin --toggle

[Desktop Action preferences]
Name=Preferences
Exec=$bin --preferences
EOF

if [[ "${1:-}" != "--no-autostart" ]]; then
    mkdir -p "$(dirname "$autostart")"
    cat > "$autostart" <<EOF
[Desktop Entry]
Type=Application
Name=Fermata
Exec=$bin
Icon=$app_id
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
fi

gtk-update-icon-cache -q -t "$data/icons/hicolor" 2>/dev/null || true
update-desktop-database -q "$data/applications" 2>/dev/null || true

echo "Fermata is installed and starting in your top bar."
nohup "$bin" >/dev/null 2>&1 &
