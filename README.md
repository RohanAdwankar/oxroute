# oxroute

Signals in, agents out.

You already talk to a coding agent from your phone, through a Slack bot that
connects to a Codex app-server on a VM. That works, and it is also the ceiling: one
Slack thread is one Codex thread, Slack is the only way in, Codex is the only
thing behind it, and the only place any of it exists is a chat log.

oxroute is the abstraction layer under that. One inbox for everything that
arrives, one fleet of agents behind whatever harness runs them, and three
surfaces — Slack, a browser, a terminal — that are the same program.

```bash
cargo build --release
cargo test --workspace
```

## The shape

```
 sources                     hub                      harnesses
 ───────                     ───                      ─────────
 slack   ─┐                                        ┌─  codex app-server
 email    ├─→  Signal  →  inbox  →  Agent  ─────────┤
 webhook ─┘                  ↕                     └─  claude code
                          surfaces
                    slack · browser · terminal
```

Four nouns and two seams, and nothing on one side of a seam names anything on
the other:

| noun | what it is |
|---|---|
| `Signal` | one thing that arrived: text, files, who sent it, what thread it continues |
| `Agent` | a long-running session on some harness, with a name you can recognise |
| `Binding` | which agent a conversation is wired to |
| `Entry` | one line of an agent's timeline — what came in, what it did |

A Slack DM and an Outlook mail both become a `Signal`. A Codex thread and a
Claude session both become an `Agent`. The hub is the only module that knows
about both sides.

## One decision, three places to make it

A signal arrives. Either it continues a thread that is already wired to an
agent — in which case it goes straight there — or it is new, and someone has
to say where it goes. That decision is the whole interface, and it is
identical in all three surfaces:

* send it to agents that already exist, one or several
* start a new agent for it, on a model you pick — which also picks the harness
* discard it

An idea of your own is not a separate flow. Type it into the inbox and it
becomes an ordinary signal, queued beside the Slack messages and routed by
the same decision. `POST /api/signal` is the same door, for anything that can
manage a webhook.

Every surface is a client of the same HTTP API, so none of them can grow a
capability the others do not have. Route something in the terminal and the
browser redraws; answer in the browser and it lands in the Slack thread.

## Ask first, or route on its own

There is one setting, and it is in the top bar.

| mode | a new thread |
|---|---|
| **auto** | starts an agent immediately. What the Slack bot has always done. |
| **ask** | waits in the inbox until you say where it goes. |

Replies to a thread that is already bound never wait, in either mode: a
continuation is not a routing decision. Mode is deliberately global and
deliberately the only knob — relevance scoring, fan-out rules and dedup are
the interesting version of this problem and are not built yet, so there is
nothing here pretending to be smart.

## What it does, which is what the Slack bot did

Full parity, because the point is that you can switch and not notice:

- direct messages only, from one account
- a top-level message opens an agent; replies resume it
- threads run concurrently; turns inside one thread are serialized
- a follow-up steers the turn that is running; `&` queues it instead
- `kill` stops a turn and keeps the session
- `clean` keeps the conversation and starts the next reply fresh
- `fork` branches the history into its own agent and its own thread
- `btw …` answers from a throwaway fork, in parallel, and folds the answer
  back in before the next real turn
- `rename "…"` renames it; otherwise a small model names it, and keeps the
  name honest as the task drifts
- a model name — `sol`, `astra`, `opus` — selects it for the thread
- images go straight to the model; other files are saved and their paths passed
- files the agent leaves in its artifact directory come back to you
- commentary and tool activity share one message that is rewritten as it goes
  and deleted when the turn ends
- one dashboard message tracks every agent; ten minutes of silence marks one
  stalled and says so once
- `/nuke` stops everything

New on top of that: the inbox, the two other surfaces, the harness seam, and
`/mode`.

## Two seams

**Sources** (`source/mod.rs`) need five things: run, reply, post a status you
can revise, fetch attachments, hand files back. Slack is wired up. Anything
else implements the trait; the parts it cannot do have defaults that say so
rather than pretending.

**Harnesses** (`agent/mod.rs`) need five: open, start, steer, interrupt, and a
stream of what they are doing. Capabilities are *declared*, not discovered,
because the difference leaks into the interface:

| harness | steer | fork | inject | how a busy agent takes a message |
|---|---|---|---|---|
| `codex` | yes | yes | yes | folds into the running turn |
| `claude-code` | no | no | no | queues until the turn ends |

Claude Code names its own session up front with `--session-id`, so oxroute
knows the id before the process has said anything and `--resume` survives a
restart. It runs with `--permission-mode bypassPermissions`, the equivalent
of the Codex harness's `approvalPolicy: never`: there is nobody here to
answer a prompt, so asking would simply stop the turn. Override it with
`OXROUTE_CLAUDE_PERMISSION_MODE`.

Every surface says which will happen before you press send, so a busy Claude
Code agent never silently swallows an urgent message.

## Moving in from the Slack bot

The import is a read of the bot's SQLite file. It never writes to it, it is
safe to run twice, and the daemon runs it on its own at startup — so both can
be installed at once and you switch when you feel like it.

```bash
deploy/install.sh          # build, install units, import. Starts nothing.
oxrouted doctor            # what it found, what is missing
```

See [MIGRATING.md](MIGRATING.md) for the switch itself.

## Running it

```bash
./dev.sh                   # both, against a scratch database. Start here.
./dev.sh ~/code/some-repo  # …with the agents pointed somewhere real

oxrouted                   # the daemon on its own: hub, Slack, HTTP + SSE
oxroute                    # the terminal UI
npm run dev                # the web UI, proxying /api to the daemon
```

`deploy/oxroute-codex.service` owns the Codex app-server. `oxrouted` is a
replaceable sidecar: it reconnects over loopback and restores any active turn
from durable metadata plus `thread/resume`. `dev.sh` watches Rust sources,
rebuilds, and replaces only the sidecar while Next.js reloads the browser UI.

Configuration is `~/.config/oxroute/config.toml` — models, which harness runs
them, where agents run, Slack, binaries, limits. `deploy/config.example.toml`
is the annotated version, and `oxrouted doctor` prints what it resolved and
from where. Environment variables override the file, which is what a systemd
unit wants; every variable the Slack bot used is still read, so an existing
`~/.config/codex-slack/env` works with no config file at all.

Slack is optional. With no tokens set the daemon runs with no sources, which
is how to try the whole thing locally. New agents default to Claude; type an
idea into the inbox, or push one in from anywhere:

```bash
curl -s localhost:8787/api/signal -H 'content-type: application/json' \
  -d '{"text":"what changed in the deploy today?"}'
```

The daemon binds to localhost and has no authentication, on purpose: anything
that can reach it can run commands as you. Reach it over an SSH tunnel.

## Layout

```
crates/oxroute-core/       the library everything else is a client of
  model.rs                 the nouns, and the words a person can type
  store.rs                 durable state, SQLite
  hub.rs                   the only module that knows about both seams
  source/{mod,slack}.rs    where signals come from
  agent/{mod,codex,claude} the harnesses
  progress.rs              what a running turn looks like to a watcher
  naming.rs                short titles from a small model
  dashboard.rs             the one message that says what everything is doing
  migrate.rs               moving in from the Slack bot
  tests/hub.rs             the tests that matter

crates/oxroute-daemon/     HTTP + SSE in front of the hub
crates/oxroute-tui/        ratatui, a client of that API
app/                       Next.js, a client of that API
deploy/                    systemd units, install script, Slack manifest
```

The TUI imports `oxroute-core` for its types, so the two clients cannot drift
on the protocol. `app/lib/types.ts` is hand-written and pinned by a test in
`model.rs`, which is the one place that could have drifted and now cannot.

## What is real and what is not

**Real**: the Slack source end to end, Socket Mode included; the Codex harness
against the app-server protocol; the Claude Code harness, run against the
binary — spawn, answer, resume, remember; the inbox, the bindings, the turn
lifecycle, steering, forking, side questions, artifacts, naming, the
dashboard, the migration; 67 tests, of which 20 drive the hub end to end
against a fake harness.

**Not yet**: Codex is exercised by tests and by the bot this is a port of, but
this build of the Codex harness has not itself been run against a live
app-server. Outlook is a trait with no implementation — `/api/signal` is the
stopgap. Nothing scores relevance, dedups a fact that arrived twice, or fans
a signal out on its own: routing is either a binding or a person. Claude Code
could fork with `--resume --fork-session`, and does not yet. There is no auth
on the daemon, and no undo on a send.

## Prior art, which is to say: the two repos this came from

`slacode` is the Slack bot, and the transport here is a faithful port of it —
the app-server call sequence, the steer-versus-start choice, the one-message
progress view, the dashboard. `sluice` is the prototype of the idea: the
inbox, the four nouns, the backend seam, and the design canvas this interface
is drawn from. oxroute is the two of them put together, in one process, with
the surfaces made equal.
