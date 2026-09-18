#!/bin/sh
# Point pi at another model on the same provider, and forget the sessions that pinned the old
# one. Edits settings.json and models.json in place, both per-machine files outside git.
#
#   ./switch-model.sh m3/GLM-5.2-mxfp4
#
# No restart is needed: every run starts a fresh agent container that reads both files.
# GNU sed; on macOS use `sed -i ''`.
set -eu

[ $# -eq 1 ] || { echo "usage: $0 <model-id>" >&2; exit 2; }
new=$1
current=$(sed -n 's/.*"defaultModel": *"\([^"]*\)".*/\1/p' settings.json)
[ -n "$current" ] || { echo "no defaultModel found in settings.json" >&2; exit 1; }

sed -i "s|\"$current\"|\"$new\"|g" settings.json models.json
rm -rf state/agent/sessions/*

echo "switched from $current to $new, sessions cleared"
grep -n '"id"\|defaultModel' settings.json models.json
