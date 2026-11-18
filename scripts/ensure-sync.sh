#!/usr/bin/env bash
# herdr starts [[startup]] only when its server boots and never restarts it.
# Run on pane focus: start bin/sync.js when no watcher is alive. bin/sync.js
# takes the pid file itself, so two racing starts leave one watcher.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr/plugins/barnuri.hc-attach}"
pid="$(cat "$DIR/sync.pid" 2>/dev/null)"
case "$pid" in ''|*[!0-9]*) ;; *) kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -qF "$ROOT/bin/sync.js" && exit 0 ;; esac
mkdir -p "$DIR" || exit 0
nohup node "$ROOT/bin/sync.js" >>"$DIR/sync.log" 2>&1 &
