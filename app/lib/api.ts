"use client";

import type { Agent, AgentView, Backend, ConversationLine, DaemonEvent, Mode, SearchResults, Snapshot } from "./types";

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

  say: (agent: string, text: string, images: File[] = []) => {
    if (images.length === 0) return post<unknown>("/api/say", { agent, text });
    const form = new FormData();
    form.append("agent", agent);
    form.append("text", text);
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
  setMode: (mode: Mode) => post<Snapshot>("/api/mode", { mode }),
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
