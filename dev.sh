#!/usr/bin/env bash
#
# Run oxroute locally: the daemon and the web UI, against a scratch database
# so nothing here touches the state a real deployment keeps.
#
#   ./dev.sh                    ~/oxroute-work as the workspace
#   ./dev.sh ~/code/some-repo   point the agents somewhere real
#
set -euo pipefail

cd "$(dirname "$0")"
workspace="${1:-$HOME/oxroute-work}"
mkdir -p "$workspace" .oxroute

# A local run uses its own config file and its own database, so it cannot
# disturb whatever a real deployment on this machine is doing.
export OXROUTE_CONFIG="${OXROUTE_CONFIG:-$PWD/.oxroute/config.toml}"
if [ ! -f "$OXROUTE_CONFIG" ]; then
  cp deploy/config.example.toml "$OXROUTE_CONFIG"
  echo "wrote $OXROUTE_CONFIG -- edit it to change models, Slack, or the workspace"
fi

export OXROUTE_OWNER="${OXROUTE_OWNER:-local}"
export OXROUTE_WORKSPACE="$workspace"
export OXROUTE_DATABASE="$PWD/.oxroute/oxroute.sqlite3"
export OXROUTE_ARTIFACTS="$PWD/.oxroute/artifacts"
export OXROUTE_ATTACHMENTS="$PWD/.oxroute/attachments"
export OXROUTE_LISTEN="${OXROUTE_LISTEN:-127.0.0.1:8787}"
export OXROUTE_LOG="${OXROUTE_LOG:-info}"
export OXROUTE_CODEX_URL="${OXROUTE_CODEX_URL:-ws://127.0.0.1:18788}"
# Left unset on purpose: with no Slack tokens the daemon runs with no
# sources, and you drive it from the UI or with POST /api/signal.

# BSD and GNU stat share no flags. Without this the watcher below dies on
# macOS, and because it owns the daemon, the daemon dies with it.
mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"
}

# Codex is optional: a machine that only runs Claude agents has no
# app-server to talk to, and should not be told about it on every start.
codex_cli="${OXROUTE_CODEX_CLI:-$HOME/.local/bin/codex}"
app_server=""
if command -v "$codex_cli" >/dev/null 2>&1; then
  env -u SLACK_APP_TOKEN -u SLACK_BOT_TOKEN \
    -u OXROUTE_SLACK_APP_TOKEN -u OXROUTE_SLACK_BOT_TOKEN \
    "$codex_cli" app-server --listen "$OXROUTE_CODEX_URL" &
  app_server=$!
else
  echo "no codex at $codex_cli -- Codex agents disabled, Claude agents fine"
  echo "  set OXROUTE_CODEX_CLI to enable them"
fi

# A reload kills whatever turn is running, and a Claude Code session cannot
# be picked up again afterwards: the answer it was in the middle of is lost
# and the agent is left stalled, which looks like an agent that did the work
# and then said nothing. So a new binary waits for the fleet to go quiet --
# but not forever, or one stuck agent would mean no reloads at all.
fleet_busy() {
  curl -fs --max-time 2 "http://$OXROUTE_LISTEN/api/state" 2>/dev/null \
    | grep -q '"status":"working"'
}

wait_for_quiet() {
  local waited=0
  while fleet_busy && [ "$waited" -lt 300 ]; do
    [ "$waited" -eq 0 ] && echo "a turn is running; the new oxrouted is waiting for it"
    sleep 2
    waited=$((waited + 2))
  done
  [ "$waited" -ge 300 ] && echo "waited five minutes; reloading over the top of it"
  return 0
}

watch_daemon() {
  local daemon signature next
  stop_daemon() {
    trap - EXIT INT TERM
    kill "$daemon" 2>/dev/null || true
    wait "$daemon" 2>/dev/null || true
    exit 0
  }
  cargo build --quiet
  ./target/debug/oxrouted &
  daemon=$!
  trap stop_daemon EXIT INT TERM
  signature=$(mtime target/debug/oxrouted)
  while true; do
    if cargo build --quiet; then
      next=$(mtime target/debug/oxrouted)
      if [ "$next" != "$signature" ]; then
        wait_for_quiet
        kill "$daemon" 2>/dev/null || true
        wait "$daemon" 2>/dev/null || true
        ./target/debug/oxrouted &
        daemon=$!
        signature=$next
        echo "reloaded oxrouted"
      fi
    fi
    sleep 1
  done
}

watch_daemon &
watcher=$!
cleanup() {
  trap - EXIT INT TERM
  kill "$watcher" ${app_server:+"$app_server"} 2>/dev/null || true
  wait "$watcher" ${app_server:+"$app_server"} 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Waiting forever for a daemon that has already died is the least useful
# thing this script could do, so give up and say what to look at.
ready=false
for _ in $(seq 1 120); do
  if curl -sf "http://$OXROUTE_LISTEN/api/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$watcher" 2>/dev/null; then
    echo "oxrouted did not start. Run ./target/debug/oxrouted directly to see why." >&2
    exit 1
  fi
  sleep 0.5
done
if [ "$ready" != true ]; then
  echo "oxrouted did not become healthy within 60 seconds." >&2
  exit 1
fi

./target/debug/oxrouted doctor || true

cat <<INFO

  oxroute is up.

    web    http://localhost:3000
    tui    ./target/debug/oxroute
    api    http://$OXROUTE_LISTEN

  Type an idea into the inbox, then route it. Ctrl-C stops everything.

INFO

npm run dev
