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
  | "merged"
  | "mergedInto"
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
  pinned: boolean;
}

export type TaskStatus = "incomplete" | "complete" | "waiting_for_human" | "blocked";

export interface TaskItem {
  id: string;
  text: string;
  status: TaskStatus;
  blockedByTaskId: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
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

export interface SearchResults {
  managed: SearchGroup[];
  other: NativeSession[];
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

export interface Snapshot {
  mode: Mode;
  /** What a new agent gets when nobody picks. Matches a `ModelInfo.id`. */
  defaultModel: string;
  agents: Agent[];
  archived: Agent[];
  messages: Record<string, string>;
  inbox: InboxItem[];
  tasks: TaskItem[];
  /** What the main column can show besides the fleet, from `[[views]]`. */
  views: ViewInfo[];
  sources: string[];
  models: ModelInfo[];
}

// -- views ---------------------------------------------------------------

export interface ViewInfo {
  id: string;
  name: string;
  /** Which component draws it: a key of `app/views/registry.tsx`. */
  kind: string;
}

/** An agent on a card or a diagram box, as little as the view needs. */
export interface CardAgent {
  id: string;
  name: string;
  status: AgentStatus;
  model: string;
}

export interface Lane {
  id: string;
  name: string;
}

export interface Card {
  number: number;
  title: string;
  url: string;
  open: boolean;
  lane: string;
  priority: string | null;
  kind: string | null;
  tracks: string[];
  tags: string[];
  body: string;
  updatedAt: string;
  agents: CardAgent[];
  tasksDone: number;
  tasksTotal: number;
}

export interface Board {
  view: string;
  name: string;
  repo: string | null;
  lanes: Lane[];
  cards: Card[];
  source: "github" | "snapshot";
  /** Whether a move writes back to GitHub. */
  writable: boolean;
  fetchedAt: number;
  /** Issues whose status has no column on this board. */
  hidden: number;
  warning: string | null;
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

export interface DiagramPayload {
  view: string;
  name: string;
  file: string;
  root: string;
  svg: string;
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Boxes a pending edit takes away. */
  removed: string[];
  /** Box id -> the agents working on it. */
  agents: Record<string, CardAgent[]>;
  /** Every agent that has worked on this diagram. */
  working: CardAgent[];
  modified: number;
}

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

/** How the next message to this agent will land, given what it is doing. */
export function deliveryOf(agent: Agent): Delivery {
  if (agent.status !== "working") return "start";
  return agent.backend === "codex" ? "steer" : "queue";
}
