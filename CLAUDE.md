# oxroute

A Rust workspace with a Next.js app beside it. `crates/oxroute-core` is the
whole system; everything else — the daemon, the TUI, the web UI — is a thin
client of it. Read `README.md` first: it explains the seams, and most changes
here are a change to one of them.

## Building and testing

```bash
cargo test --workspace     # 139 tests; tests/hub.rs is the set that matters
cargo build --release
npm run lint && npm run build
```

Run both. The Rust and TypeScript halves share a wire format and nothing
checks it across the boundary except `the_wire_names_the_web_ui_reads_do_not_move`
in `crates/oxroute-core/src/model.rs`.

Run it with `./dev.sh`, which uses `.oxroute/` for its config and database
so a local run cannot disturb a real deployment on the same machine.

## Things that are easy to get wrong

**Config is a file first, environment second.** `config.rs` layers them in
that order and nothing else should read `std::env` — the harnesses used to,
and it meant settings could not be configured where people look for them.

**`Live`'s locks are `std::sync::Mutex` on purpose.** The harness event pump
touches them from a context where awaiting an async lock can park the only
thread a current-thread runtime has. Never hold one of those guards across an
`.await`, and never swap them for `tokio::sync::Mutex`.

**Surfaces have no behaviour.** If you find yourself adding logic to the TUI,
the web UI or the Slack adapter that the other two do not have, it belongs in
`hub.rs` behind an API endpoint instead. That equivalence is the product.

**Capabilities are declared, not discovered.** A harness that cannot steer
says so in `capabilities()`, and the surfaces show that before a send. Do not
probe at runtime, and do not let a `queue` silently look like a `steer`.

**The migration only ever reads.** `migrate.rs` opens the Slack bot's
database read-only and must stay that way; someone may still be running it.

**`app/lib/types.ts` is hand-written.** Rust serializes these types as
camelCase. If you add or rename a wire field, update the TypeScript and the
test that pins it.

**Claude Code says nothing until it is spoken to.** Its `system/init` frame
only arrives after the first user message, so never wait for it before
sending — that deadlocks. `--session-id` is why `open()` can return early.

## Adding a source or a harness

Implement the trait in `source/mod.rs` or `agent/mod.rs` and register it in
`hub.rs` (`with_source` / `with_harness`, both called before the hub is
shared). Optional methods have defaults that refuse honestly; prefer that to
a silent no-op. `tests/hub.rs` has a fake of each to copy.

## Adding a view

A view is another way of drawing the main column. Its kind is a `ViewKind`
variant in `config.rs`, which is also where its `[[views]]` keys are checked;
what it does lives in the core or the daemon behind `/api/views/{id}/…`; and
it is drawn by a component in `app/views/` registered in
`app/views/registry.tsx`. Keep the component to drawing. Board logic is in
`board.rs` and the hub; diagram logic is in the daemon's `diagram.rs`, next
to the task diagram, because only the daemon links oxdraw.

**A board writes exactly one thing back: the `status:` label.** It reads the
issue fresh before the write so a label added on GitHub since the last fetch
is never dropped. Everything else on a card — agents, task progress — is
oxroute's own state, joined in from `view_links` and the task list.

**A diagram is written before an agent hears about it.** A saved diagram
with nobody told is recoverable; an agent building to a change the file does
not have is not.
