"use client";

import type {
  Agent,
  AgentView,
  Arranged,
  Backend,
  Board,
  ConversationLine,
  DaemonEvent,
  DiagramEdit,
  DiagramPayload,
  Mode,
  SearchResults,
  Snapshot,
  TaskItem,
} from "./types";

// Everything goes through this origin. Next forwards regular calls while the
// events route streams explicitly, so the daemon can stay bound to localhost.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const multipart = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(path, {
    ...init,
    headers: { ...(multipart ? {} : { "content-type": "application/json" }), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
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
}

const post = <T,>(path: string, payload: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(payload) });

export const api = {
  snapshot: () => call<Snapshot>("/api/state"),
  search: (query: string) => call<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`),
  continueSession: (backend: Backend, sessionId: string) =>
    post<Agent>("/api/continue", { backend, sessionId }),
  nativePreview: (backend: Backend, sessionId: string) =>
    call<ConversationLine[]>(`/api/native-preview?backend=${encodeURIComponent(backend)}&sessionId=${encodeURIComponent(sessionId)}`),

  /** Put a thought of your own into the inbox, beside everything else. */
  note: (text: string) => post<{ signal: string }>("/api/signal", { text, source: "you" }),
  agent: (id: string) => call<AgentView>(`/api/agents/${encodeURIComponent(id)}`),

  routeExisting: (signal: string, agentIds: string[]) =>
    post<Snapshot>("/api/route", { signal, action: "existing", agentIds }),
  routeSpawn: (signal: string, model?: string) =>
    post<Snapshot>("/api/route", { signal, action: "spawn", model }),
  discard: (signal: string) => post<Snapshot>("/api/route", { signal, action: "discard" }),

  /// `queued` waits for the running turn instead of folding into it.
  say: (agent: string, text: string, images: File[] = [], queued = false) => {
    if (images.length === 0) return post<unknown>("/api/say", { agent, text, queued });
    const form = new FormData();
    form.append("agent", agent);
    form.append("text", text);
    form.append("queued", String(queued));
    images.forEach((image) => form.append("images", image));
    return call<unknown>("/api/say-images", { method: "POST", body: form });
  },
  interrupt: (agent: string) => post<unknown>("/api/interrupt", { agent }),
  fork: (agent: string) => post<{ agent: Agent }>("/api/fork", { agent }),
  forkLocal: (agent: string) => post<{ agent: Agent }>("/api/fork-local", { agent }),
  merge: (agent: string) => post<{ agent: Agent }>("/api/merge", { agent }),
  rename: (agent: string, name: string) => post<unknown>("/api/rename", { agent, name }),
  archive: (agent: string, archived: boolean) =>
    post<Snapshot>("/api/archive", { agent, archived }),
  pin: (agent: string, pinned: boolean) => post<Snapshot>("/api/pin", { agent, pinned }),
  createTask: (text: string, agentId = "") =>
    post<TaskItem>("/api/tasks", { text, agentId }),
  /// Hand a task to an agent that does not exist yet: a new one, or a fork
  /// of whoever has it.
  handOffTask: (id: string, fork: boolean, model?: string) =>
    post<TaskItem>(`/api/tasks/${id}/hand-off`, { fork, model }),
  /// A task made in a composer, with whatever was attached to it.
  createTaskWithImages: (text: string, agentId: string, images: File[]) => {
    const form = new FormData();
    form.append("text", text);
    form.append("agentId", agentId);
    images.forEach((image) => form.append("images", image));
    return call<TaskItem>("/api/task-images", { method: "POST", body: form });
  },
  /// Put a task after another one; no `after` means the top of the queue.
  moveTask: (id: string, after?: string) =>
    post<TaskItem[]>(`/api/tasks/${encodeURIComponent(id)}/move`, { after }),
  /// A status change carries why it changed.
  updateTask: (task: TaskItem, note?: string) =>
    call<TaskItem>(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        text: task.text,
        status: task.status,
        blockedByTaskId: task.blockedByTaskId,
        agentId: task.agentId,
        note,
      }),
    }),
  deleteTask: (id: string) =>
    call<unknown>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setMode: (mode: Mode) => post<Snapshot>("/api/mode", { mode }),

  // Tags and boards. A board is its settings; moving a card is tagging it.
  tag: (agent: string, change: { add?: string[]; remove?: string[]; set?: string[] }) =>
    post<string[]>(`/api/agents/${encodeURIComponent(agent)}/tags`, change),
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
  diagram: (agent: string) => call<DiagramPayload>(`/api/agents/${encodeURIComponent(agent)}/diagram`),
  previewDiagram: (agent: string, edits: DiagramEdit[]) =>
    post<DiagramPayload>(`/api/agents/${encodeURIComponent(agent)}/diagram/preview`, { edits }),
  sendDiagram: (agent: string, edits: DiagramEdit[], note: string) =>
    post<DiagramPayload>(`/api/agents/${encodeURIComponent(agent)}/diagram/send`, { edits, note }),
  /// `about` narrows what to draw; empty asks for the whole architecture.
  createDiagram: (agent: string, about = "") =>
    post<unknown>(`/api/agents/${encodeURIComponent(agent)}/diagram/create`, { about }),
  renderDiagram: (source: string, added: string[] = []) =>
    post<{ svg: string }>("/api/diagram/render", { source, added }),
};

/**
 * Follow the daemon's event stream.
 *
 * `EventSource` reconnects on its own, and the daemon opens every connection
 * with a `sync`, so a reconnect resyncs without either side tracking what was
 * missed.
 */
export function follow(onEvent: (event: DaemonEvent) => void): () => void {
  const stream = new EventSource("/api/events");
  stream.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as DaemonEvent);
    } catch {
      /* a frame we cannot read is not worth taking the stream down for */
    }
  };
  return () => stream.close();
}
