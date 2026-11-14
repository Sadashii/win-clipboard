#!/usr/bin/env bash
# Installs (or updates) the extension for the current user.
set -euo pipefail
cd "$(dirname "$0")"
UUID="win-clipboard@local"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
glib-compile-schemas schemas
mkdir -p "$DEST/schemas"
mkdir -p "$DEST/data"
cp metadata.json *.js stylesheet.css "$DEST/"
cp data/emoji.json "$DEST/data/"
cp schemas/*.xml schemas/gschemas.compiled "$DEST/schemas/"
echo "Installed to $DEST"
if gnome-extensions list | grep -qx "$UUID"; then
  gnome-extensions enable "$UUID" && echo "Enabled. If you just updated it, log out and back in to reload."
else
  echo "First install: log out and back in, then run: gnome-extensions enable $UUID"
fi
