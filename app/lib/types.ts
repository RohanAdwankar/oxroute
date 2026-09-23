// Mirrors of the daemon's wire types. The Rust side renames to camelCase on
// serialization, so these are the shapes as they arrive, not as they are
// declared. `crates/oxroute-core/src/model.rs` is the source of truth; a test
// there pins the field names these depend on.

export type Backend = "codex" | "claude-code";
export type Delivery = "start" | "steer" | "queue";
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
  | "notice";
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
  origin: string;
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

export interface ModelInfo {
  alias: string;
  id: string;
  label: string;
  backend: Backend;
}

export interface Snapshot {
  mode: Mode;
  /** What a new agent gets when nobody picks. Matches a `ModelInfo.id`. */
  defaultModel: string;
  agents: Agent[];
  inbox: InboxItem[];
  sources: string[];
  models: ModelInfo[];
}

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

/** How the next message to this agent will land, given what it is doing. */
export function deliveryOf(agent: Agent): Delivery {
  if (agent.status !== "working") return "start";
  return agent.backend === "codex" ? "steer" : "queue";
}
