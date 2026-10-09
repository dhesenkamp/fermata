#!/usr/bin/env bash
# Installs the Fermata GNOME Shell extension for the current user. No sudo needed.
#
#   ./install.sh              install (or update) and turn it on
#   ./install.sh --pack       only build the zip for extensions.gnome.org
#   ./install.sh --uninstall  remove it again (your settings stay)
set -euo pipefail

uuid="fermata@dhesenkamp.github.io"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
cli="$HOME/.local/bin/fermata"

pack() {
    gnome-extensions pack "$here/extension" --force --out-dir="$1" \
        --extra-source=lib --extra-source=sounds >/dev/null
    echo "$1/$uuid.shell-extension.zip"
}

if [[ "${1:-}" == "--pack" ]]; then
    zip="$(pack "$here")"
    echo "Built $(basename "$zip"), ready to upload to extensions.gnome.org."
    exit 0
fi

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$uuid" 2>/dev/null || true
    gnome-extensions uninstall "$uuid" 2>/dev/null || rm -rf "$data/gnome-shell/extensions/$uuid"
    rm -f "$cli"
    echo "Fermata removed. Your settings stay in dconf under /org/gnome/shell/extensions/fermata/."
    exit 0
fi

if ! command -v gnome-extensions >/dev/null; then
    echo "Fermata is a GNOME Shell extension, and GNOME Shell wasn't found."
    echo "For other desktops, use version 0.1: git checkout v0.1.0"
    exit 1
fi
shell_version="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 0)"
if (( shell_version < 45 )); then
    echo "Fermata needs GNOME 45 or newer (Ubuntu 23.10+); this is GNOME $shell_version."
    echo "Version 0.1 works on older systems: git checkout v0.1.0"
    exit 1
fi

# Version 0.1 was a separate Python app. Stop it and remove its launcher and login entry.
if [[ -f "$cli" ]] && head -1 "$cli" | grep -q python; then
    "$cli" --quit 2>/dev/null || true
    rm -f "$config/autostart/io.github.dhesenkamp.Fermata.desktop" \
        "$data/applications/io.github.dhesenkamp.Fermata.desktop" \
        "$data/icons/hicolor/scalable/apps/io.github.dhesenkamp.Fermata.svg"
    echo "Removed Fermata 0.1 (the Python app)."
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gnome-extensions install --force "$(pack "$tmp")"
install -Dm755 "$here/bin/fermata" "$cli"

if gnome-extensions enable "$uuid" 2>/dev/null; then
    echo "Fermata is installed and running in your top bar."
else
    # GNOME Shell only notices new extensions when it starts. Mark it enabled for then.
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" != *"$uuid"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['$uuid']"
        else
            gsettings set org.gnome.shell enabled-extensions "${current%]}, '$uuid']"
        fi
    fi
    echo "Fermata is installed. GNOME Shell picks up new extensions when it restarts:"
    if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
        echo "  press Alt+F2, type r and press Enter."
    else
        echo "  log out and back in."
    fi
fi

case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
        echo
        echo "To use the 'fermata' command in a terminal, add ~/.local/bin to your PATH:"
        echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.${SHELL##*/}rc"
        ;;
esac
