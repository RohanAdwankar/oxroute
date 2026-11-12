"use client";

import { recordClientFailure } from "./client-failures";

import type { DiffQuote } from "./drafts";

import type {
  Agent,
  AgentView,
  Entry,
  Arranged,
  Backend,
  Board,
  ConversationLine,
  DaemonEvent,
  DiagramEdit,
  DiagramPayload,
  Mode,
  SearchGroup,
  NativeSession,
  Snapshot,
  TaskItem,
  Workstream,
} from "./types";

// Everything goes through this origin. Next forwards regular calls while the
// events route streams explicitly, so the daemon can stay bound to localhost.
async function call<T>(path: string, init?: RequestInit, retries = !init?.method || init.method === "GET" ? 2 : 0): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const multipart = typeof FormData !== "undefined" && init?.body instanceof FormData;
      const response = await fetch(path, {
        ...init,
        headers: { ...(multipart ? {} : { "content-type": "application/json" }), ...(init?.headers ?? {}) },
        cache: "no-store",
      });
      status = response.status;
      const body = await response.text();
      if (!response.ok) {
        // The daemon puts a readable reason in the body. Surface that rather
        // than a status code nobody can act on.
        let reason = body;
        try {
          reason = JSON.parse(body).error ?? body;
        } catch {
          /* the body was not JSON; show it as it came */
        }
        throw new Error(reason || `${response.status} ${response.statusText}`);
      }
      return body ? (JSON.parse(body) as T) : (undefined as T);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      recordClientFailure(path, init, status, error);
      if (attempt < retries && error instanceof TypeError && (status === 0 || status === 200)) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
}

const post = <T,>(path: string, payload: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(payload) });

const creatingAgents = new Map<string, Promise<Agent>>();
const unsavedAgents = new Set<string>();
async function readyAgent(id: string) {
  if (unsavedAgents.has(id)) await api.createAgent(id);
}
async function agentPost<T>(agent: string, path: string, payload: unknown) {
  await readyAgent(agent);
  return post<T>(path, payload);
}

export const api = {
  snapshot: () => call<Snapshot>("/api/state"),
  search: (query: string, signal?: AbortSignal) => call<SearchGroup[]>(`/api/search?q=${encodeURIComponent(query)}`, { signal }),
  /// The harnesses' own sessions, which take as long as they take.
  searchNative: (query: string, signal?: AbortSignal) =>
    call<NativeSession[]>(`/api/search/native?q=${encodeURIComponent(query)}`, { signal }),
  continueSession: (backend: Backend, sessionId: string) =>
    post<Agent>("/api/continue", { backend, sessionId }),
  nativePreview: (backend: Backend, sessionId: string, signal?: AbortSignal) =>
    call<ConversationLine[]>(`/api/native-preview?backend=${encodeURIComponent(backend)}&sessionId=${encodeURIComponent(sessionId)}`, { signal }),

  /** Put a thought of your own into the inbox, beside everything else. */
  note: (text: string) => post<{ signal: string }>("/api/signal", { text, source: "you" }),
  searchContext: (id: string, entry: number, signal?: AbortSignal) =>
    call<Entry[]>(`/api/agents/${encodeURIComponent(id)}/context/${entry}`, { signal }),
  createAgent: (id: string): Promise<Agent> => {
    const pending = creatingAgents.get(id);
    if (pending) return pending;
    unsavedAgents.add(id);
    const request = post<Agent>("/api/agents", { id }).then(agent => {
      unsavedAgents.delete(id);
      return agent;
    }).finally(() => creatingAgents.delete(id));
    creatingAgents.set(id, request);
    return request;
  },
  agent: async (id: string, before?: number, priority: RequestPriority = "high") => {
    await readyAgent(id);
    return call<AgentView>(`/api/agents/${encodeURIComponent(id)}${before === undefined ? "" : `?before=${before}`}`, { headers: { "x-oxroute-compact": "1" }, priority });
  },
  recentMessages: (id: string, signal: AbortSignal) => call<Entry[]>(`/api/agents/${encodeURIComponent(id)}/messages`, { signal }),
  toolOutputs: (id: string, first: number, last: number, signal: AbortSignal) =>
    call<Record<string, string>>(`/api/agents/${encodeURIComponent(id)}/outputs?${new URLSearchParams({ first: String(first), last: String(last) })}`, { signal, priority: "high" }),

  routeExisting: (signal: string, agentIds: string[]) =>
    post<Snapshot>("/api/route", { signal, action: "existing", agentIds }),
  routeSpawn: (signal: string, model?: string) =>
    post<Snapshot>("/api/route", { signal, action: "spawn", model }),
  discard: (signal: string) => post<Snapshot>("/api/route", { signal, action: "discard" }),

  /// `queued` waits for the running turn instead of stopping it.
  say: async (agent: string, text: string, images: File[] = [], queued = false, diffs: DiffQuote[] = [], requestId = crypto.randomUUID()) => {
    await readyAgent(agent);
    if (images.length === 0) return call<unknown>("/api/say", { method: "POST", body: JSON.stringify({ agent, text, queued, diffs, requestId }) }, 2);
    const form = new FormData();
    form.append("agent", agent);
    form.append("text", text);
    form.append("queued", String(queued));
    form.append("diffs", JSON.stringify(diffs));
    form.append("requestId", requestId);
    images.forEach((image) => form.append("files", image));
    return call<unknown>("/api/say-attachments", { method: "POST", body: form }, 2);
  },
  interrupt: (agent: string) => agentPost<unknown>(agent, "/api/interrupt", { agent }),
  fork: (agent: string) => agentPost<{ agent: Agent }>(agent, "/api/fork", { agent }),
  forkInChat: (agent: string) => agentPost<{ agent: Agent }>(agent, "/api/fork-in-chat", { agent }),
  quoteThread: (agent: string, quote: import("./types").QuoteAnchor) => agentPost<{ agent: Agent }>(agent, "/api/fork-in-chat", { agent, quote }),
  merge: (agent: string, into?: string, archive = false) => agentPost<{ agent: Agent }>(agent, "/api/merge", { agent, into, archive }),
  rename: (agent: string, name: string) => agentPost<unknown>(agent, "/api/rename", { agent, name }),
  archive: (agent: string, archived: boolean, completeTasks = false) =>
    agentPost<Snapshot>(agent, "/api/archive", { agent, archived, completeTasks }),
  pin: (agent: string, pinned: boolean) => agentPost<Snapshot>(agent, "/api/pin", { agent, pinned }),
  /// "" takes the reaction back. The daemon streams the reaction
  /// without refetching the snapshot or locking unrelated controls.
  react: (entry: number, reaction: string) => post<void>("/api/react", { entry, reaction }),
  /// Move a running session onto another model its harness can run.
  setModel: (agent: string, model: string) =>
    agentPost<{ model: string }>(agent, `/api/agents/${encodeURIComponent(agent)}/model`, { model }),
  createTask: (text: string, agentId = "", parentTaskId = "") =>
    agentPost<TaskItem>(agentId, "/api/tasks", { text, agentId, parentTaskId }),
  /// Hand a task to an agent that does not exist yet: a new one, or a fork
  /// of whoever has it.
  handOffTask: (id: string, fork: boolean, model?: string) =>
    post<TaskItem>(`/api/tasks/${id}/hand-off`, { fork, model }),
  /// A task made in a composer, with whatever was attached to it.
  createTaskWithImages: async (text: string, agentId: string, images: File[], parentTaskId = "") => {
    await readyAgent(agentId);
    if (images.length === 0) return api.createTask(text, agentId, parentTaskId);
    const form = new FormData();
    form.append("text", text);
    form.append("agentId", agentId);
    form.append("parentTaskId", parentTaskId);
    images.forEach((image) => form.append("files", image));
    return call<TaskItem>("/api/task-attachments", { method: "POST", body: form });
  },
  /// Put a task after another one; no `after` means the top of the queue.
  moveTask: (id: string, after?: string) =>
    post<TaskItem[]>(`/api/tasks/${encodeURIComponent(id)}/move`, { after }),
  /// Saying no to finished work: the agent hears why, and it is work again.
  correctTask: (id: string, text: string, images: File[] = [], queued = false) => {
    const form = new FormData();
    form.append("text", text);
    form.append("queued", String(queued));
    images.forEach((image) => form.append("files", image));
    return call<TaskItem>(`/api/tasks/${encodeURIComponent(id)}/correction`, {
      method: "POST",
      body: form,
    });
  },
  approveTaskTree: (id: string) => post<TaskItem[]>(`/api/tasks/${encodeURIComponent(id)}/approve-all`, {}),
  /// A status change carries why it changed, and only a person approves.
  updateTask: (task: TaskItem, note?: string, approved = false) =>
    call<TaskItem>(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        text: task.text,
        status: task.status,
        blockedByTaskId: task.blockedByTaskId,
        parentTaskId: task.parentTaskId,
        agentId: task.agentId,
        note,
        approved,
      }),
    }),
  deleteTask: (id: string) =>
    call<unknown>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setMode: (mode: Mode) => post<Snapshot>("/api/mode", { mode }),
  setNextActionMode: (mode: Mode) => post<Snapshot>("/api/next-action-mode", { mode }),

  // Tags and boards. A board is its settings; moving a card is tagging it.
  tag: (agent: string, change: { add?: string[]; remove?: string[]; set?: string[] }) =>
    agentPost<string[]>(agent, `/api/agents/${encodeURIComponent(agent)}/tags`, change),
  updateWorkstream: (agent: string, brief: Workstream) =>
    call<Workstream>(`/api/agents/${encodeURIComponent(agent)}/workstream`, { method: "PUT", body: JSON.stringify(brief) }),
  createBoard: (board: Partial<Board> = {}) => post<Board>("/api/boards", board),
  updateBoard: (board: Board) =>
    call<Board>(`/api/boards/${encodeURIComponent(board.id)}`, {
      method: "PUT",
      body: JSON.stringify(board),
    }),
  deleteBoard: (id: string) =>
    call<unknown>(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" }),
  arrange: (id: string) => call<Arranged>(`/api/boards/${encodeURIComponent(id)}`),
  moveCard: (board: string, agent: string, column: string | null, row: string | null) =>
    post<string[]>(`/api/boards/${encodeURIComponent(board)}/move`, { agent, column, row }),

  // Drawing a message instead of typing one.
  diagram: async (agent: string) => {
    await readyAgent(agent);
    return call<DiagramPayload>(`/api/agents/${encodeURIComponent(agent)}/diagram`);
  },
  previewDiagram: (agent: string, edits: DiagramEdit[]) =>
    agentPost<DiagramPayload>(agent, `/api/agents/${encodeURIComponent(agent)}/diagram/preview`, { edits }),
  /// `queued` waits for the running turn instead of stopping it.
  sendDiagram: (agent: string, edits: DiagramEdit[], note: string, queued = false) =>
    agentPost<DiagramPayload>(agent, `/api/agents/${encodeURIComponent(agent)}/diagram/send`, {
      edits,
      note,
      queued,
    }),
  /// `about` narrows what to draw; empty asks for the whole architecture.
  createDiagram: (agent: string, about = "") =>
    agentPost<unknown>(agent, `/api/agents/${encodeURIComponent(agent)}/diagram/create`, { about }),
  renderDiagram: (source: string, added: string[] = []) =>
    post<{ svg: string }>("/api/diagram/render", { source, added }),
};

/** Share the live event connection across tabs so downloads have free connections. */
export function follow(onEvent: (event: DaemonEvent) => void): () => void {
  const receive = (message: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(message.data) as DaemonEvent);
    } catch {
      /* Ignore malformed frames. Reconnection starts with a fresh sync. */
    }
  };
  // Keep live updates available on browsers without shared workers.
  if (typeof SharedWorker === "undefined") {
    let stream: EventSource;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      stream?.close();
      stream = new EventSource("/api/events");
      const alive = () => {
        clearTimeout(timer);
        timer = setTimeout(connect, 15000);
      };
      stream.addEventListener("heartbeat", alive);
      stream.onmessage = event => { alive(); receive(event); };
      alive();
    };
    connect();
    return () => { stream.close(); clearTimeout(timer); };
  }
  // Idle tabs keep workers alive. Change this revision when the worker changes.
  const worker = new SharedWorker("/events-worker.js?v=2");
  worker.port.onmessage = receive;
  const close = () => {
    worker.port.postMessage("close");
    worker.port.close();
    window.removeEventListener("pagehide", leave);
  };
  const leave = (event: PageTransitionEvent) => { if (!event.persisted) close(); };
  window.addEventListener("pagehide", leave);
  return close;
}
