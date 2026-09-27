#!/usr/bin/env bash
#
# What is waiting when the take starts: six things from two places, two of
# which deserve no agent at all. None of it costs the film any time.
set -euo pipefail

api="${OXROUTE_DEMO_API:-http://127.0.0.1:8799}"

# Ask first, so the film shows the decision being made.
curl -sf -X POST "$api/api/mode" -H 'content-type: application/json' \
  -d '{"mode": "ask"}' > /dev/null

# `slack` is the real source's name and routes itself; these are stand-ins
# for what a source would post, so they wait to be sorted.
arrives() {
  curl -sf -X POST "$api/api/signal" -H 'content-type: application/json' \
    -d "{\"source\": \"$1\", \"conversation\": \"C1\", \"user\": \"$2\", \"text\": \"$3\"}" > /dev/null
}

arrives Slack ops "the health endpoint returns 200 with an empty body. Make it report the version and the commit."
arrives email support "parcels come back in a random order. Sort them by id."
arrives Slack design "the parcels response needs a total count alongside the list."
arrives email billing "invoice 4021 is still unpaid"
arrives Slack office "reminder: the office is closed on Friday"
arrives email ops "also log the port the server starts on."
