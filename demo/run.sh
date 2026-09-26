#!/usr/bin/env bash
#
# Walk the whole of oxroute once, and film it.
#
#   ./demo/run.sh
#
# Nothing here touches a real deployment or the dev database: the daemon
# gets its own config, its own sqlite file and its own port, the web UI is
# pointed at that daemon, and the agents work in a scratch repository. What
# comes out is demo/out -- one video, and a still per beat.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
stage="${OXROUTE_DEMO_STAGE:-$root/.oxroute/demo}"
out="$root/demo/out"
rm -rf "$stage" "$out"
mkdir -p "$stage/workspace" "$out"

# A repository, because an agent that has nowhere to work is not a demo of
# anything.
git init -q "$stage/workspace"
printf 'the shed\n=======\n\nit needs painting.\n' > "$stage/workspace/README.md"
git -C "$stage/workspace" add README.md
git -C "$stage/workspace" -c user.email=demo@oxroute -c user.name=demo commit -qm "the shed"

cp deploy/config.example.toml "$stage/config.toml"

export OXROUTE_CONFIG="$stage/config.toml"
export OXROUTE_OWNER=demo
export OXROUTE_WORKSPACE="$stage/workspace"
export OXROUTE_DATABASE="$stage/oxroute.sqlite3"
export OXROUTE_ARTIFACTS="$stage/artifacts"
export OXROUTE_ATTACHMENTS="$stage/attachments"
export OXROUTE_LISTEN="${OXROUTE_DEMO_LISTEN:-127.0.0.1:8799}"
export OXROUTE_DEFAULT_MODEL="${OXROUTE_DEMO_MODEL:-claude-sonnet-5}"
export OXROUTE_LOG=warn
web_port="${OXROUTE_DEMO_PORT:-3100}"
export OXROUTE_DAEMON="http://$OXROUTE_LISTEN"
export OXROUTE_DEMO_URL="http://127.0.0.1:$web_port"
export OXROUTE_DEMO_API="$OXROUTE_DAEMON"
export OXROUTE_DEMO_OUT="$out"

cargo build --quiet
./target/debug/oxrouted > "$stage/daemon.log" 2>&1 &
daemon=$!
# Its own build, in its own output directory: a dev server may well be
# running in this checkout already, and Next allows only one of those.
export OXROUTE_DIST=".next-demo"
npx next build > "$stage/build.log" 2>&1
npx next start --port "$web_port" > "$stage/web.log" 2>&1 &
web=$!

cleanup() {
  trap - EXIT INT TERM
  kill "$daemon" "$web" 2>/dev/null || true
  wait "$daemon" "$web" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wait_for() {
  for _ in $(seq 1 120); do
    curl -sf "$1" > /dev/null 2>&1 && return 0
    sleep 1
  done
  echo "never came up: $1" >&2
  return 1
}

wait_for "$OXROUTE_DAEMON/api/health"
wait_for "$OXROUTE_DEMO_URL"

node demo/walk.mjs
echo "wrote $out"
