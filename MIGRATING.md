# Moving in from the Codex Slack bot

The goal is that you do not have to be awake for this. Both can be installed
at once, the import only ever reads the bot's database, and the switch itself
is two `systemctl` lines you can run whenever it suits you.

## What comes across

| in `codex-slack` | in oxroute |
|---|---|
| `threads` — Slack thread → Codex thread | an `Agent` per Codex thread, and a `Binding` per Slack thread |
| `models` — per-thread model | the agent's model |
| `sessions` — task, permalink, status | the agent's name, deep link and status |
| `pending_context` — unfolded `btw` answers | still pending, still folded in before the next turn |
| `dashboard` — the message id | the same message, taken over rather than replaced |

Two Slack threads pointing at one Codex thread — which is what `fork` leaves
behind — become one agent with two bindings, which is what they always were.

Anything the old table claimed was `working` is imported as **stalled**,
because after a migration nothing is. Reply in the thread and it resumes.

## The order to do it in

**1. Install. Nothing starts, nothing stops.**

```bash
git clone <this repo> ~/oxroute && cd ~/oxroute
deploy/install.sh --with-web
```

The bot keeps running throughout. The import reads
`~/.local/share/codex-slack/state/threads.sqlite3` (or
`$CODEX_SLACK_DATABASE`) with the read-only flag set.

**2. Configure.**

```bash
$EDITOR ~/.config/oxroute/env
oxrouted doctor
```

Every variable the bot used is read as a fallback, so the fastest possible
start is to point oxroute at the file you already have:

```bash
ln -s ~/.config/codex-slack/env ~/.config/oxroute/env
```

`SLACK_ALLOWED_USER_ID`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `CODEX_CLI` and
`CODEX_SLACK_WORKSPACE` all still work. `doctor` prints what it resolved.

**3. Decide which Slack app to use.**

Two Socket Mode clients on the same app token both receive every event and
both answer, so pick one:

*Reuse the existing app* — simplest. Stop the bot before starting oxroute, and
the same DM conversation carries on. `/mode` needs adding to the app's slash
commands; `/nuke` is already there.

*Make a second app* from `deploy/slack-manifest.json` — safer. You get a
separate DM conversation to try oxroute in while the bot keeps serving the old
one. The imported bindings point at the old conversation, so old threads will
not resume in the new app; new work starts clean.

**4. Switch.**

```bash
systemctl --user stop codex-slack
systemctl --user disable codex-slack
systemctl --user enable --now oxroute
systemctl --user enable --now oxroute-web   # optional
```

Reply in any existing Slack thread. It resumes the Codex thread it always had.

**5. Reach the UIs.**

The daemon and the web UI both bind to localhost and neither has
authentication, because anything that can reach them can run commands as you.
From your laptop:

```bash
ssh -N -L 8787:127.0.0.1:8787 -L 3939:127.0.0.1:3939 your-vm
```

Then the browser is on <http://127.0.0.1:3939>, and the terminal UI is:

```bash
oxroute http://127.0.0.1:8787
```

## Going back

Nothing is destroyed. The bot's database is untouched, so:

```bash
systemctl --user stop oxroute
systemctl --user start codex-slack
```

Work oxroute did in the meantime lives in its own database and in the same
Codex threads, so the bot picks those threads up again as if nothing had
happened. What it will not have is the inbox, or any agent oxroute started in
a thread the bot never saw.

## If something is wrong

```bash
oxrouted doctor                        # config, binaries, what is importable
journalctl --user -u oxroute -f        # what it is doing
OXROUTE_LOG=debug oxrouted             # including every line to and from codex
oxrouted migrate --force               # re-import over the top
```

`codex app-server --stdio` is what oxroute runs. If your Codex build has
dropped or renamed that flag, set `OXROUTE_CODEX_ARGS` rather than patching
anything — `doctor` will not catch it, but the first turn will fail loudly.
