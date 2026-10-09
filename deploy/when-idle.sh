#!/usr/bin/env bash
# Apply only a prepared, tested release, after active turns finish.
set -euo pipefail
umask 077
state=${OXROUTE_DEPLOY_STATE:-$HOME/.local/state/oxroute}
api=${OXROUTE_API:-http://127.0.0.1:8787}
request=$state/pending-deployment.json
test -f "$request" || exit 0
exec 9>"$state/deploy.lock"
flock -n 9 || exit 0
idle() { curl -fsS --max-time 5 "$api/api/state" | jq -e '[.agents[] | select(.status == "working")] | length == 0' >/dev/null; }
idle || exit 0
sleep 2
idle || exit 0
release=$(jq -er '.release' "$request")
repository=$(jq -er '.repository' "$request")
commit=$(jq -er '.commit' "$request")
version=$(jq -er '.version' "$request")
test "$(git -C "$repository" rev-parse HEAD)" = "$commit"
test -z "$(git -C "$repository" status --porcelain --untracked-files=no)"
test -x "$release/bin/oxrouted"
test "$(cat "$release/web/.next/BUILD_ID")" = "$version"
test "$(sha256sum "$release/bin/oxrouted" | cut -d ' ' -f1)" = "$(jq -er '.binarySha256' "$request")"
binary=$HOME/.local/bin/oxrouted
web=$HOME/.local/share/oxroute/web
database=$HOME/.local/state/oxroute/oxroute.sqlite3
backup=$(mktemp -d "$state/deploy-backup.XXXXXX")
cleanup() { find "$backup" -depth -delete; }
trap cleanup EXIT
uv run --no-project python -c 'import sqlite3,sys; sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True).backup(sqlite3.connect(sys.argv[2]))' "$database" "$backup/database.sqlite3"
cp -a "$binary" "$backup/oxrouted"
cp -a "$web" "$backup/web"
task_status() {
  jq -c --arg status "$1" --arg note "$2" --arg group "${3:-tasks}" '. as $r | .[$group][]? | {id, text, agentId:$r.agentId, status:$status, note:$note}' "$request" |
  while IFS= read -r task; do
    curl -fsS --max-time 10 -X PUT "$api/api/tasks/$(jq -r .id <<< "$task")" -H 'Content-Type: application/json' -d "$task" >/dev/null
  done
}
rollback() {
  trap - ERR EXIT
  systemctl --user stop oxroute-web.service oxroute.service
  cp -a "$backup/web" "$web.next"
  mv -Tf "$web.next" "$web"
  cp -a "$backup/oxrouted" "$binary.next"
  mv -Tf "$binary.next" "$binary"
  # Restore review bodies stripped by migration, without reverting other data.
  uv run --no-project python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("ATTACH DATABASE ? AS previous",(sys.argv[2],)); c.execute("INSERT OR REPLACE INTO kv SELECT * FROM previous.kv WHERE key GLOB '\''review:*'\''"); c.commit()' "$database" "$backup/database.sqlite3"
  systemctl --user start oxroute.service oxroute-web.service
  task_status waiting_for_human "Deployment failed; previous release and review records restored. Inspect the idle-deploy journal."
  mv "$request" "$state/failed-deployment.json"
  cleanup
}
if ! idle; then
  exit 0
fi
trap rollback ERR
systemctl --user stop oxroute-web.service oxroute.service
ln -s "$release/bin/oxrouted" "$binary.next"
mv -Tf "$binary.next" "$binary"
ln -s "$release/web" "$web.next"
mv -Tf "$web.next" "$web"
systemctl --user start oxroute.service oxroute-web.service
curl --retry 30 --retry-delay 1 --retry-connrefused -fsS "$api/api/health" >/dev/null
test "$(curl --retry 30 --retry-delay 1 --retry-connrefused -fsS http://127.0.0.1:3939/api/version | jq -er .version)" = "$version"
cmp -s "$release/bin/oxrouted" "$binary"
TEST_URL=http://127.0.0.1:3939 node "$repository/tests/queued-corrections.mjs"
TEST_URL=http://127.0.0.1:3939 node "$repository/tests/wrap.mjs"
TEST_URL=http://127.0.0.1:3939 node "$repository/tests/git-review.mjs"
TEST_URL=http://127.0.0.1:3939 node "$repository/tests/panes.mjs"
TEST_URL=http://127.0.0.1:3939 node "$repository/tests/task-search.mjs"
trap - ERR
task_status done "Deployed after all active turns finished. Live daemon, frontend build ID, Tab correction, wrapping and review browser checks passed."
mv "$request" "$state/deployed.json"
request=$state/deployed.json
task_status incomplete "Deployment verified; resume the authorized follow-up work." resumeTasks
printf '%s deployed %s\n' "$(date --iso-8601=seconds)" "$commit"
