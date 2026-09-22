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

codex_cli="${OXROUTE_CODEX_CLI:-$HOME/.local/bin/codex}"
env -u SLACK_APP_TOKEN -u SLACK_BOT_TOKEN \
  -u OXROUTE_SLACK_APP_TOKEN -u OXROUTE_SLACK_BOT_TOKEN \
  "$codex_cli" app-server --listen "$OXROUTE_CODEX_URL" &
app_server=$!

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
  signature=$(stat -c %y target/debug/oxrouted)
  while true; do
    if cargo build --quiet; then
      next=$(stat -c %y target/debug/oxrouted)
      if [ "$next" != "$signature" ]; then
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
  kill "$watcher" "$app_server" 2>/dev/null || true
  wait "$watcher" "$app_server" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

until curl -sf "http://$OXROUTE_LISTEN/api/health" >/dev/null 2>&1; do sleep 0.5; done

./target/debug/oxrouted doctor || true

cat <<INFO

  oxroute is up.

    web    http://localhost:3000
    tui    ./target/debug/oxroute
    api    http://$OXROUTE_LISTEN

  Type an idea into the inbox, then route it. Ctrl-C stops everything.

INFO

npm run dev
