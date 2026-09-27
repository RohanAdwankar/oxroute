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
out="${OXROUTE_DEMO_OUT:-$root/demo/out}"
rm -rf "$stage" "$out"
mkdir -p "$stage/workspace" "$out"

# A small service to work on, in a few files, because an architecture
# diagram of one file is not an architecture.
git init -q "$stage/workspace"
mkdir -p "$stage/workspace/src" "$stage/workspace/docs"
cat > "$stage/workspace/README.md" <<'MD'
# parcels

A small HTTP service. `/parcels` lists them, `/health` says whether it is up.
MD
cat > "$stage/workspace/src/server.js" <<'JS'
const http = require("http");
const { route } = require("./routes");

const server = http.createServer(route);
if (require.main === module) server.listen(process.env.PORT || 8080);
module.exports = { server };
JS
cat > "$stage/workspace/src/routes.js" <<'JS'
const { parcels } = require("./store");

function route(request, answer) {
  if (request.url === "/health") {
    answer.writeHead(200);
    answer.end();
    return;
  }
  if (request.url === "/parcels") {
    answer.writeHead(200, { "content-type": "application/json" });
    answer.end(JSON.stringify(parcels()));
    return;
  }
  answer.writeHead(404);
  answer.end();
}

module.exports = { route };
JS
cat > "$stage/workspace/src/store.js" <<'JS'
const kept = [
  { id: "p3", to: "Lisbon" },
  { id: "p1", to: "Porto" },
  { id: "p2", to: "Faro" },
];

function parcels() {
  return kept;
}

module.exports = { parcels };
JS
cat > "$stage/workspace/docs/architecture.mmd" <<'MMD'
flowchart TD
  server[server]
  routes[routes]
  store[store]
  server --> routes
  routes --> store

%% OXDRAW CODE server src/server.js
%% OXDRAW CODE routes src/routes.js
%% OXDRAW CODE store src/store.js
MMD
git -C "$stage/workspace" add .
git -C "$stage/workspace" -c user.email=demo@oxroute -c user.name=demo commit -qm "parcels"

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
export OXROUTE_DIST="${OXROUTE_DIST:-.next-demo}"
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

# oxdemo drives the browser: a cursor you can follow, captions, and the
# waits cut out of the film rather than sat through.
# The script names a URL; a take on its own ports gets its own copy of the
# script with that URL in it, so two takes can film at once.
take="$stage/oxroute.oxd"
sed "s|^url .*|url $OXROUTE_DEMO_URL|" demo/oxroute.oxd > "$take"
cp demo/seed.sh "$stage/seed.sh"
oxdemo record "$take" --out "$out"
echo "wrote $out"
