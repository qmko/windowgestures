#!/bin/sh

set -e

## compile schemas
cd src

UUID=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')

## Always compile schemas before packaging
glib-compile-schemas schemas/

## Zip whole files
if command -v zip >/dev/null 2>&1; then
	zip -r "../${UUID}.zip" ./*
else
	python3 -c "import shutil; shutil.make_archive('../${UUID}','zip','.')"
fi

cd ..