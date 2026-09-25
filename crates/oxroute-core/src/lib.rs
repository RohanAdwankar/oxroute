//! oxroute: signals in, agents out.
//!
//! Context arrives continuously -- Slack messages, mail, webhooks -- and the
//! agents that should act on it are already running somewhere. oxroute is the
//! layer in between: one inbox for everything that arrives, one fleet of
//! agents behind whatever harness runs them, and three co-equal surfaces onto
//! the same state.
//!
//! The shape of the crate follows the shape of the problem:
//!
//! | module      | what it owns                                        |
//! |-------------|-----------------------------------------------------|
//! | [`model`]   | the nouns, and the control words a person can type   |
//! | [`store`]   | durable state, in SQLite                             |
//! | [`source`]  | where signals come from; Slack is the one wired up   |
//! | [`agent`]   | the harnesses: Codex and Claude Code                 |
//! | [`hub`]     | the only thing that knows about both sides           |
//! | [`board`]   | issues as cards, for a board view                     |
//! | [`progress`]| what a running turn looks like to a person watching  |
//! | [`migrate`] | moving in from the Slack bot this replaces           |
//!
//! Surfaces -- the daemon's HTTP API, the TUI, the web UI -- sit on top of
//! [`hub::Hub`] and are deliberately thin. Anything a surface can do, all of
//! them can do, because none of them has behaviour of its own.

pub mod agent;
pub mod board;
pub mod config;
pub mod dashboard;
pub mod hub;
pub mod migrate;
pub mod model;
pub mod naming;
pub mod progress;
pub mod rpc;
pub mod source;
pub mod store;

pub use config::{Config, Mode};
pub use hub::{Hub, Routing, Snapshot};
pub use model::{
    Agent, Backend, ConversationLine, Delivery, Event, InboxItem, NativeSession,
    SearchDestination, SearchGroup, SearchResults, Signal, Target, TaskItem, TaskStatus,
};
pub use store::Store;
