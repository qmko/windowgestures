#!/bin/sh

## compile schemas
cd src

UUID=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')

## Remove compiled schemas
rm schemas/gschemas.compiled

## Zip whole files
if command -v zip >/dev/null 2>&1; then
	zip -r "../${UUID}.zip" ./*
else
	python3 -c "import shutil; shutil.make_archive('../${UUID}','zip','.')"
fi

## Recompile schemas
glib-compile-schemas schemas/

cd ..