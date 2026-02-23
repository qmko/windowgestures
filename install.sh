#!/bin/sh

set -e

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC_DIR="$REPO_DIR/src"

UUID=$(sed -n 's/.*"uuid": "\([^"]*\)".*/\1/p' "$SRC_DIR/metadata.json")
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST_DIR/schemas"

cp "$SRC_DIR/extension.js" "$DEST_DIR/extension.js"
cp "$SRC_DIR/metadata.json" "$DEST_DIR/metadata.json"
cp "$SRC_DIR/prefs.js" "$DEST_DIR/prefs.js"
cp "$SRC_DIR/stylesheet.css" "$DEST_DIR/stylesheet.css"
cp "$SRC_DIR/schemas/org.gnome.shell.extensions.windowgestures.gschema.xml" "$DEST_DIR/schemas/org.gnome.shell.extensions.windowgestures.gschema.xml"

glib-compile-schemas "$DEST_DIR/schemas"

echo "Installed to: $DEST_DIR"
echo "Log out and log back in to restart GNOME Shell."