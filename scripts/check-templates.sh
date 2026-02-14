#!/bin/sh
set -eu

base="docs/reference/templates"
required="
AGENTS.md
SOUL.md
TOOLS.md
IDENTITY.md
USER.md
HEARTBEAT.md
BOOTSTRAP.md
"

missing=0
for name in $required; do
  path="$base/$name"
  if [ ! -f "$path" ]; then
    echo "missing template: $path" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi

echo "ok: required workspace templates are present"
