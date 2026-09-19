"use client";

import type { AgentView, DaemonEvent, Mode, Snapshot } from "./types";

// Everything goes through this origin; next.config.ts forwards /api to the
// daemon, so the daemon can stay bound to localhost.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
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

  /** Put a thought of your own into the inbox, beside everything else. */
  note: (text: string) => post<{ signal: string }>("/api/signal", { text, source: "you" }),
  agent: (id: string) => call<AgentView>(`/api/agents/${encodeURIComponent(id)}`),

  routeExisting: (signal: string, agentIds: string[]) =>
    post<Snapshot>("/api/route", { signal, action: "existing", agentIds }),
  routeSpawn: (signal: string, model?: string) =>
    post<Snapshot>("/api/route", { signal, action: "spawn", model }),
  discard: (signal: string) => post<Snapshot>("/api/route", { signal, action: "discard" }),

  say: (agent: string, text: string) => post<unknown>("/api/say", { agent, text }),
  interrupt: (agent: string) => post<unknown>("/api/interrupt", { agent }),
  fork: (agent: string) => post<unknown>("/api/fork", { agent }),
  rename: (agent: string, name: string) => post<unknown>("/api/rename", { agent, name }),
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
