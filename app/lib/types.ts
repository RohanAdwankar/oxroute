// Mirrors of the daemon's wire types. The Rust side renames to camelCase on
// serialization, so these are the shapes as they arrive, not as they are
// declared. `crates/oxroute-core/src/model.rs` is the source of truth; a test
// there pins the field names these depend on.

export type Backend = "codex" | "claude-code";
export type Delivery = "start" | "restart";
export type AgentStatus = "working" | "stalled" | "complete";
export type InboxState = "waiting" | "done";
export type EntryKind =
  | "received"
  | "said"
  | "worked"
  | "asked"
  | "you"
  | "forked"
  | "forkedFrom"
  | "merged"
  | "mergedInto"
  | "notice"
  | "review";
export type Mode = "ask" | "auto";

export interface Attachment {
  id: string;
  name: string;
  mimetype: string;
  url: string;
}

export interface Signal {
  id: string;
  source: string;
  conversation: string;
  threadKey: string;
  externalId: string;
  author: string;
  label: string;
  text: string;
  attachments: Attachment[];
  at: number;
  root: boolean;
}

export interface Agent {
  id: string;
  name: string;
  backend: Backend;
  model: string;
  sessionId: string;
  cwd: string;
  status: AgentStatus;
  activity: string;
  permalink: string;
  lastActivity: number;
  updatedAt: number;
  stallReason: string | null;
  stallAlerted: boolean;
  pinned: boolean;
}

/** `done` is the agent's claim; `complete` is a person agreeing with it. */
export type TaskStatus = "incomplete" | "done" | "complete" | "waiting_for_human" | "blocked";

export interface TaskItem {
  id: string;
  text: string;
  status: TaskStatus;
  blockedByTaskId: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  /** Pictures that came with it, as names under the attachments route. */
  images: string[];
}

export interface InboxItem {
  signal: Signal;
  state: InboxState;
  outcome: string;
  agentIds: string[];
  /** The agent this thread is already wired to. Pre-ticked when routing. */
  suggested: string | null;
}

export interface Entry {
  id: number;
  agentId: string;
  at: number;
  kind: EntryKind;
  text: string;
  detail: string;
  output: string;
  origin: string;
  slackUrl?: string;
  /// "up", "down", or "" for none.
  reaction: string;
}

export interface SearchDestination {
  agentId: string;
  agentName: string;
  entryId: number;
}

export interface SearchGroup {
  at: number;
  kind: EntryKind;
  text: string;
  detail: string;
  origin: string;
  destinations: SearchDestination[];
}

export interface NativeSession {
  backend: Backend;
  sessionId: string;
  name: string;
  preview: string;
  cwd: string;
  model: string;
  updatedAt: number;
}

export interface ConversationLine {
  role: string;
  text: string;
}

export interface ModelInfo {
  alias: string;
  id: string;
  label: string;
  backend: Backend;
}

/** Why a task is where it is. */
export interface TaskNote {
  id: string;
  taskId: string;
  text: string;
  /** The agent that wrote it; empty when a person did. */
  agentId: string;
  at: number;
}

export interface Snapshot {
  mode: Mode;
  /** What a new agent gets when nobody picks. Matches a `ModelInfo.id`. */
  defaultModel: string;
  agents: Agent[];
  archived: Agent[];
  messages: Record<string, string>;
  /** Child pane -> parent pane for forks that stay in the same chat. */
  paneLinks: Record<string, string>;
  inbox: InboxItem[];
  tasks: TaskItem[];
  taskNotes: TaskNote[];
  /** Agent id -> its tags. */
  tags: Record<string, string[]>;
  /** Every board, in tab order. */
  boards: Board[];
  sources: string[];
  models: ModelInfo[];
  backends: BackendInfo[];
}

/** What a harness can do, so the UI never has to name backends itself. */
export interface BackendInfo {
  backend: Backend;
  fork: boolean;
  merge: boolean;
}

// -- tags and boards -------------------------------------------------------

/**
 * A saved arrangement of sessions by their tags. `columns` and `rows` are
 * tag keys; with both set the board is a grid. See `crates/oxroute-core/src/tags.rs`.
 */
export interface Board {
  id: string;
  name: string;
  columns: string;
  columnOrder: string[];
  rows: string;
  rowOrder: string[];
  /** Keys offered as filters. */
  filters: string[];
  /** Tags a card must have: any within a key, all across keys. */
  selected: string[];
  /** A key to sort cards by; empty for most recent first. */
  sort: string;
  createdAt: number;
  updatedAt: number;
}

export interface BoardRow {
  /** Null is the row of sessions without the row key. */
  value: string | null;
  /** Agent ids per cell, lined up with `Arranged.columns`. */
  cells: string[][];
}

export interface Arranged {
  board: Board;
  /** Column values; null is the column of sessions without the key. */
  columns: (string | null)[];
  rows: BoardRow[];
  sessions: Record<string, Agent>;
  /** Every key in use, with its values. */
  values: Record<string, string[]>;
  /** Bare tags in use. */
  plain: string[];
  shown: number;
  total: number;
}

export interface CodeRef {
  file: string;
  lines: string | null;
  symbol: string | null;
}

export interface DiagramNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  code: CodeRef | null;
  change: "added" | "renamed" | null;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string | null;
  added: boolean;
}

/** An agent's architecture diagram, as the composer draws it. */
export type DiagramPayload =
  | { exists: false; file: string; modified: number }
  | {
      exists: true;
      file: string;
      modified: number;
      svg: string;
      width: number;
      height: number;
      nodes: DiagramNode[];
      edges: DiagramEdge[];
      /** Boxes a pending edit takes away. */
      removed: string[];
    };

/** A pending change to a diagram, held here until it is applied. */
export type DiagramEdit =
  | { op: "addNode"; id: string; label: string }
  | { op: "addEdge"; from: string; to: string; label?: string }
  | { op: "rename"; id: string; label: string }
  | { op: "removeNode"; id: string }
  | { op: "removeEdge"; from: string; to: string };

export interface AgentView {
  agent: Agent;
  timeline: Entry[];
  delivery: Delivery;
}

export type DaemonEvent =
  | { type: "sync" }
  | { type: "signalReceived"; signal: Signal }
  | { type: "inboxChanged"; item: InboxItem }
  | { type: "agentChanged"; agent: Agent }
  | { type: "timeline"; entry: Entry }
  | { type: "progress"; agentId: string; text: string }
  | { type: "turnStarted"; agentId: string }
  | { type: "turnFinished"; agentId: string; status: string }
  | { type: "notice"; text: string };
