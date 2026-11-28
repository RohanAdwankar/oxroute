# agent-harness

One Rust interface over the coding agents that run your work: Claude Code and Codex. Nothing above the `Harness` trait names a concrete agent.

The lifecycle is:

- `open`: attach to a session, or make one
- `start`: run a turn
- `interrupt`: stop a turn without losing the session
- `steer`: add context to a running turn without stopping its tools
- `events`: a stream of what the agent is doing
- `fork`, `inject`, `recover`, `set_name`, `release`, `search_sessions`: optional, per harness

Each harness declares what it supports in `Capabilities` (`fork`, `inject`, `resume`, `steer`) instead of the caller discovering it by failure.

## Relation to the Agent Client Protocol

The Agent Client Protocol (ACP) covers `initialize`, `session/new`, `session/load`, `session/resume`, `session/prompt`, `session/cancel` and `session/close`, plus `session/fork` in its unstable schema. It has no way to splice history into a session without running a turn, to steer a turn that is already running, or to reattach to a turn that outlived the client. Those are the reasons this crate exists. Where ACP covers an operation, the trait maps onto it.

## Use

```rust
use agent_harness::{claude::{ClaudeConfig, ClaudeHarness}, Harness, SessionSpec, TurnInput};
```

`ClaudeConfig` and `CodexConfig` carry the binary path, default working directory and model settings. The crate reads no global configuration.
