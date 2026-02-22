#!/bin/sh

set -e

## compile schemas
cd src

UUID=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')

## Always compile schemas before packaging
glib-compile-schemas schemas/

## Create minimal extension package only
python3 -c "import zipfile; files=['extension.js','metadata.json','prefs.js','stylesheet.css','schemas/org.gnome.shell.extensions.windowgestures.gschema.xml']; out='../${UUID}.zip'; z=zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED); [z.write(f, f) for f in files]; z.close()"

cd ..
