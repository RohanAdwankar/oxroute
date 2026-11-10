"use client";

import { useEffect, useState } from "react";
import type { DiffQuote } from "./drafts";
import type { DiagramEdit } from "./types";

export type PinnedMessage = { id: string; text: string; files: File[]; diffs: DiffQuote[]; edits?: DiagramEdit[]; correction?: string };
let disk: Promise<IDBDatabase> | undefined;
const cached = new Map<string, PinnedMessage[]>();
const loads = new Map<string, Promise<PinnedMessage[]>>();
let writes = Promise.resolve();
let windowId: string | undefined;
function storageKey(agent: string) {
  if (!windowId) {
    windowId = sessionStorage.getItem("oxroute.pinWindow") ?? undefined;
    // Popups inherit sessionStorage; only their first document shares the opener's namespace.
    try { if (window.opener && windowId === window.opener.sessionStorage.getItem("oxroute.pinWindow")) windowId = undefined; } catch { /* A cross-origin opener cannot share these pins. */ }
    windowId ??= crypto.randomUUID();
    sessionStorage.setItem("oxroute.pinWindow", windowId);
  }
  return `${windowId}:${agent}`;
}
function database() {
  return disk ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("oxroute.pinnedMessages", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("messages");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function load(agent: string): Promise<PinnedMessage[]> {
  if (!loads.has(agent)) loads.set(agent, stored(agent).then(saved => {
    const messages = [...new Map([...saved, ...(cached.get(agent) ?? [])].map(message => [message.id, message])).values()];
    cached.set(agent, messages);
    return messages;
  }));
  return loads.get(agent)!;
}
async function stored(agent: string, messages?: PinnedMessage[]) {
  const key = storageKey(agent);
  const db = await database();
  return new Promise<PinnedMessage[]>((resolve, reject) => {
    const transaction = db.transaction("messages", messages ? "readwrite" : "readonly");
    const store = transaction.objectStore("messages");
    const request = messages ? store.put(messages, key) : store.get(key);
    transaction.oncomplete = () => resolve(messages ?? request.result ?? []);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Keep unsent payloads, including File objects, across pane changes and reloads. */
export function usePinnedMessages(agent: string, report: (message: string) => void) {
  const [messages, setMessages] = useState<PinnedMessage[]>(() => cached.get(agent) ?? []);
  const [saving, setSaving] = useState(0);
  useEffect(() => {
    let active = true;
    void load(agent).then(() => {
      if (active) setMessages(cached.get(agent)!);
    }).catch(() => { if (active) report("Could not load pinned messages. Reload before sending a saved message."); });
    return () => { active = false; };
  }, [agent, report]);
  const change = (next: PinnedMessage[]) => {
    cached.set(agent, next); setMessages(next);
    setSaving(count => count + 1);
    const saved = writes.catch(() => {}).then(() => load(agent)).then(() => stored(agent, cached.get(agent)!));
    writes = saved.then(() => {}, () => {});
    return saved.catch(() => {
      report("Pinned messages could not be saved. Keep this window open to preserve them.");
    }).finally(() => setSaving(count => count - 1));
  };
  return { messages, saving: saving > 0, remove: (id: string) => change((cached.get(agent) ?? messages).filter(message => message.id !== id)) };
}
