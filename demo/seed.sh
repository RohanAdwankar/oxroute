#!/usr/bin/env bash
#
# What is on screen when the take starts: one request waiting in the inbox,
# and one finished piece of work waiting to be looked at. Neither needs an
# agent, so neither costs the film any time.
set -euo pipefail

api="${OXROUTE_DEMO_API:-http://127.0.0.1:8799}"

# Ask first, so the film shows the decision being made.
curl -sf -X POST "$api/api/mode" -H 'content-type: application/json' \
  -d '{"mode": "ask"}' > /dev/null

curl -sf -X POST "$api/api/signal" -H 'content-type: application/json' -d '{
  "source": "demo",
  "conversation": "C1",
  "user": "ops",
  "text": "the health endpoint returns 200 with an empty body. Make it report the version and the commit."
}' > /dev/null
