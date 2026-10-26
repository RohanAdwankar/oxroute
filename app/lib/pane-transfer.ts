"use client";

import { useEffect, useRef, type DragEvent } from "react";
import { clearDraft, composerDraft, receiveDraft, type ComposerDraft } from "./drafts";
import { paneIds, type PaneEdge, type PaneLayout } from "./panes";

export const PANE_TRANSFER = "application/x-oxroute-transfer";
export const carriesPane = (data: DataTransfer) => data.types.includes(PANE_TRANSFER);
type Ticket = { source: string; token: string };
export type PaneOffer = Ticket & { root: string; layout: PaneLayout; origin: PaneLayout };
export type PaneDestination = { kind: "tab" } | { kind: "pane"; id: string; edge: PaneEdge };
type Payload = PaneOffer & { drafts: Record<string, ComposerDraft> };
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
type Options = {
  ready: boolean; known: string[];
  receive: (offer: PaneOffer, destination: PaneDestination, local: boolean) => (() => void) | false;
  depart: (offer: PaneOffer) => void;
  error: (message: string) => void;
};

function ticket(data: string): Ticket | null {
  try {
    const value = JSON.parse(data);
    return typeof value?.source === "string" && typeof value?.token === "string" ? value : null;
  } catch { return null; }
}

/** Hand off ownership only after the receiving window has mounted every pane. */
export function usePaneTransfer(options: Options) {
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const source = useRef(nonce());
  const channel = useRef<BroadcastChannel | null>(null);
  const offers = useRef(new Map<string, { offer: PaneOffer; sent?: Payload; timer: ReturnType<typeof setTimeout> }>());
  const waiting = useRef(new Map<string, { destination: PaneDestination; timer: ReturnType<typeof setTimeout> }>());
  const cancelled = useRef(false);
  const dragging = useRef<string | null>(null);
  const delivery = useRef(Promise.resolve());

  const finish = (token: string) => {
    const pending = offers.current.get(token);
    if (!pending?.sent) return;
    clearTimeout(pending.timer); offers.current.delete(token);
    const ids = paneIds(pending.offer.layout);
    const changed = ids.some(id => {
      const now = composerDraft(id), sent = pending.sent!.drafts[id];
      return now.text !== sent.text || JSON.stringify(now.diffs) !== JSON.stringify(sent.diffs) ||
        now.files.length !== sent.files.length || now.files.some((file, index) => file !== sent.files[index]);
    });
    if (changed) { latest.current.error("The draft changed while moving. Kept the original pane open."); return; }
    for (const id of ids) clearDraft(id);
    latest.current.depart(pending.offer);
  };

  const deliver = async (payload: Payload, destination: PaneDestination) => {
    const local = payload.source === source.current, ids = paneIds(payload.layout);
    const deadline = Date.now() + 10000;
    let applied = false;
    while (Date.now() < deadline) {
      const current = latest.current;
      if (!applied && current.ready && ids.every(id => current.known.includes(id))) {
        const apply = current.receive(payload, destination, local);
        if (!apply) break;
        const url = new URL(window.location.href);
        if (url.searchParams.has("transfer")) { url.searchParams.delete("transfer"); window.history.replaceState(null, "", url); }
        if (!local) for (const id of ids) receiveDraft(id, payload.drafts[id]);
        apply();
        applied = true;
      }
      if (applied && ids.every(id => document.querySelector(`[data-agent-pane="${CSS.escape(id)}"]`))) {
        if (local) {
          const pending = offers.current.get(payload.token);
          if (pending) clearTimeout(pending.timer);
          offers.current.delete(payload.token);
        } else channel.current?.postMessage({ kind: "accepted", target: payload.source, token: payload.token });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    latest.current.error("Could not move the pane. The original window was kept open.");
  };

  const queue = (payload: Payload, destination: PaneDestination) => {
    delivery.current = delivery.current.then(() => deliver(payload, destination))
      .catch(() => latest.current.error("Could not move the pane. The original window was kept open."));
  };

  const request = (value: Ticket, destination: PaneDestination) => {
    const pending = offers.current.get(value.token);
    if (value.source === source.current && pending) {
      queue({ ...pending.offer, drafts: {} }, destination);
      return;
    }
    if (!channel.current) { latest.current.error("This browser does not support moving panes between windows."); return; }
    const timer = setTimeout(() => {
      waiting.current.delete(value.token);
      latest.current.error("The source window did not respond. The original pane was kept open.");
    }, 10000);
    waiting.current.set(value.token, { destination, timer });
    channel.current.postMessage({ kind: "request", target: value.source, token: value.token, source: source.current });
  };

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragging.current) { cancelled.current = true; event.stopImmediatePropagation(); }
    };
    const ended = () => { dragging.current = null; };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("drop", ended, true);
    window.addEventListener("dragend", ended);
    if (typeof BroadcastChannel !== "undefined") {
      const port = new BroadcastChannel("oxroute.pane-transfer");
      channel.current = port;
      port.onmessage = ({ data }) => {
        if (data.target !== source.current) return;
        if (data.kind === "request") {
          const pending = offers.current.get(data.token);
          if (!pending) return;
          pending.sent ??= { ...pending.offer, drafts: Object.fromEntries(paneIds(pending.offer.layout).map(id => [id, composerDraft(id)])) };
          port.postMessage({ kind: "payload", target: data.source, payload: pending.sent });
        } else if (data.kind === "payload") {
          const pending = waiting.current.get(data.payload?.token);
          if (!pending) return;
          clearTimeout(pending.timer); waiting.current.delete(data.payload.token);
          queue(data.payload, pending.destination);
        } else if (data.kind === "accepted") finish(data.token);
      };
    }
    const params = new URLSearchParams(window.location.search);
    const incoming = ticket(params.get("transfer") ?? "");
    if (incoming) {
      request(incoming, { kind: "tab" });
    }
    const pendingOffers = offers.current, pendingRequests = waiting.current;
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("drop", ended, true);
      window.removeEventListener("dragend", ended);
      channel.current?.close(); channel.current = null;
      for (const pending of pendingOffers.values()) clearTimeout(pending.timer);
      for (const pending of pendingRequests.values()) clearTimeout(pending.timer);
    };
    // The channel lives for this document; event handlers read current options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const offer = (root: string, layout: PaneLayout, origin = layout) => {
    const value = { root, layout, origin, source: source.current, token: nonce() };
    const timer = setTimeout(() => {
      offers.current.delete(value.token);
      if (dragging.current === value.token) dragging.current = null;
    }, 60000);
    offers.current.set(value.token, { offer: value, timer });
    return value;
  };
  const open = (value: PaneOffer, x?: number, y?: number) => {
    if (!channel.current) { latest.current.error("This browser does not support moving panes between windows."); return; }
    const url = new URL(window.location.href); url.search = "";
    url.searchParams.set("agent", paneIds(value.layout)[0]);
    url.searchParams.set("transfer", JSON.stringify({ source: value.source, token: value.token }));
    url.searchParams.set("detached", "1");
    const popup = window.open(url.href, "_blank", `popup,width=1100,height=800${x === undefined ? "" : `,left=${x},top=${y}`}`);
    if (!popup) {
      const pending = offers.current.get(value.token);
      if (pending) clearTimeout(pending.timer);
      offers.current.delete(value.token);
      latest.current.error("The browser blocked the new window. Allow popups or use Move to new window again.");
    }
  };
  return {
    start: (event: DragEvent, root: string, layout: PaneLayout, origin = layout) => {
      cancelled.current = false;
      const value = offer(root, layout, origin);
      dragging.current = value.token;
      event.dataTransfer.setData(PANE_TRANSFER, JSON.stringify({ source: value.source, token: value.token }));
      event.dataTransfer.effectAllowed = "move";
    },
    drop: (event: DragEvent, destination: PaneDestination) => {
      const value = ticket(event.dataTransfer.getData(PANE_TRANSFER));
      if (!value) return;
      event.preventDefault(); event.stopPropagation(); request(value, destination);
    },
    end: (event: DragEvent) => {
      const token = dragging.current;
      dragging.current = null;
      if (cancelled.current || event.dataTransfer.dropEffect !== "none") return;
      if (event.clientX >= 0 && event.clientY >= 0 && event.clientX < innerWidth && event.clientY < innerHeight) return;
      const pending = token && offers.current.get(token);
      if (pending) open(pending.offer, event.screenX, event.screenY);
    },
    detach: (root: string, layout: PaneLayout, origin = layout) => open(offer(root, layout, origin)),
  };
}
