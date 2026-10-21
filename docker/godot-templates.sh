#!/bin/sh
# Godot with the export templates built into this image (harness-sandbox-3d:export).
# Godot looks for its templates in the data folder of the user who runs it
# ($XDG_DATA_HOME, else ~/.local/share: godot/export_templates/<version>), and a
# sandbox's user and HOME are known only when it runs, so the templates are
# linked there first. Everything else goes straight to Godot.
data="${XDG_DATA_HOME:-${HOME:-/tmp}/.local/share}/godot/export_templates"
for t in /opt/godot/export_templates/*/; do
  [ -d "$t" ] || continue
  v=$(basename "$t")
  [ -e "$data/$v" ] || { mkdir -p "$data" && ln -s "${t%/}" "$data/$v"; } 2>/dev/null || true
done
exec /opt/godot/godot "$@"
