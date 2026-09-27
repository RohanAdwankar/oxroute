#!/usr/bin/env bash
#
# What is waiting when the take starts: three things in the inbox, one of
# which deserves no agent at all. None of it costs the film any time.
set -euo pipefail

api="${OXROUTE_DEMO_API:-http://127.0.0.1:8799}"

# Ask first, so the film shows the decision being made.
curl -sf -X POST "$api/api/mode" -H 'content-type: application/json' \
  -d '{"mode": "ask"}' > /dev/null

arrives() {
  curl -sf -X POST "$api/api/signal" -H 'content-type: application/json' \
    -d "{\"source\": \"demo\", \"conversation\": \"C1\", \"user\": \"$1\", \"text\": \"$2\"}" > /dev/null
}

arrives ops "the health endpoint returns 200 with an empty body. Make it report the version and the commit."
arrives support "parcels come back in a random order. Sort them by id."
arrives office "reminder: the office is closed on Friday"
