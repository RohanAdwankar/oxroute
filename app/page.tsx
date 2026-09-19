"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { AgentPanel } from "./components/AgentPanel";
import { Chrome } from "./components/Chrome";
import { Fleet } from "./components/Fleet";
import { Inbox } from "./components/Inbox";
import { api, follow } from "./lib/api";
import {
  HINTS,
  defaultVimMode,
  getVimMode,
  isTyping,
  setVimMode,
  subscribeVimMode,
} from "./lib/keys";
import type { AgentView, InboxItem, Mode, Snapshot } from "./lib/types";

const EMPTY: Snapshot = {
  mode: "auto",
  defaultModel: "",
  agents: [],
  inbox: [],
  sources: [],
  models: [],
};

/**
 * The whole interface.
 *
 * It keeps no state the daemon does not have. The event stream only bumps a
 * revision counter; every read is a refetch keyed on that counter. Which is
 * why a decision made in the TUI shows up here a moment later without either
 * surface knowing the other exists.
 */
export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [revision, setRevision] = useState(0);
  const [routing, setRouting] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  // Which column the keyboard drives, and where it is in each.
  const [focus, setFocus] = useState<"inbox" | "fleet">("inbox");
  const [inboxAt, setInboxAt] = useState(0);
  const [fleetAt, setFleetAt] = useState(0);
  const vim = useSyncExternalStore(subscribeVimMode, getVimMode, defaultVimMode);
  const compose = useRef<HTMLTextAreaElement>(null);

  const say = useCallback((text: string) => {
    setNotice(text);
    // A message that stays forever stops being read.
    window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 6000);
  }, []);

  const reload = useCallback(() => setRevision((current) => current + 1), []);

  const complain = useCallback(
    (error: unknown) => say(error instanceof Error ? error.message : String(error)),
    [say],
  );

  // The stream never reads; it only says that something changed.
  useEffect(
    () =>
      follow((event) => {
        switch (event.type) {
          case "progress":
            // High-frequency and one field wide, so it is patched in place
            // rather than costing a refetch several times a second.
            setSnapshot((current) => ({
              ...current,
              agents: current.agents.map((agent) =>
                agent.id === event.agentId ? { ...agent, activity: event.text } : agent,
              ),
            }));
            break;
          case "timeline":
            // Append in place. A full refetch per tool call would make the
            // timeline stutter exactly when there is most to watch.
            setDetail((current) =>
              current && current.agent.id === event.entry.agentId
                ? { ...current, timeline: [...current.timeline, event.entry] }
                : current,
            );
            break;
          case "notice":
            say(event.text);
            break;
          default:
            reload();
        }
      }),
    [reload, say],
  );

  useEffect(() => {
    let live = true;
    api.snapshot().then(
      (next) => {
        if (!live) return;
        setSnapshot(next);
        setReady(true);
      },
      (error: unknown) => live && complain(error),
    );
    return () => {
      live = false;
    };
  }, [revision, complain]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.agent(open).then(
      (view) => live && setDetail(view),
      (error: unknown) => live && complain(error),
    );
    return () => {
      live = false;
    };
  }, [open, revision, complain]);

  /** Every mutation runs through here, so failures always reach the top bar. */
  const run = useCallback(
    async (work: () => Promise<unknown>, after?: () => void) => {
      setBusy(true);
      try {
        await work();
        after?.();
        reload();
      } catch (error) {
        complain(error);
      } finally {
        setBusy(false);
      }
    },
    [reload, complain],
  );

  const toggleVim = useCallback(() => setVimMode(!getVimMode()), []);

  const selected = snapshot.inbox.find((item) => item.signal.id === routing) ?? null;
  // Only trust the detail we have if it is for the agent that is open; a
  // stale one would flash the wrong timeline while the next fetch lands.
  const showing = open && detail?.agent.id === open ? detail : null;

  const clearRouting = () => {
    setRouting(null);
    setTicked(new Set());
  };

  const pick = (item: InboxItem) => {
    const at = snapshot.inbox.findIndex((i) => i.signal.id === item.signal.id);
    if (at >= 0) setInboxAt(at);
    if (item.state !== "waiting") {
      // A settled item is history. Jump to where it went.
      const destination = item.agentIds[0];
      if (destination) {
        clearRouting();
        setOpen(destination);
      }
      return;
    }
    openRouting(item);
  };

  // Routing a signal, from wherever the keyboard or the mouse asked.
  const sendTo = useCallback(
    (signalId: string, agentIds: string[]) => {
      if (agentIds.length === 0) return;
      void run(() => api.routeExisting(signalId, agentIds), clearRouting);
    },
    [run],
  );

  const openRouting = useCallback(
    (item: InboxItem) => {
      setOpen(null);
      setRouting(item.signal.id);
      setTicked(new Set(item.suggested ? [item.suggested] : []));
      setFocus("fleet");
      // Start on the agent this thread already belongs to, if it has one.
      const at = snapshot.agents.findIndex((a) => a.id === item.suggested);
      setFleetAt(at >= 0 ? at : 0);
    },
    [snapshot.agents],
  );

  const toggle = (id: string) =>
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) {
        // Escape gets you out of the compose box and back to the keys.
        if (event.key === "Escape") (event.target as HTMLElement).blur();
        return;
      }

      const inbox = snapshot.inbox;
      const fleet = snapshot.agents;
      const here = focus === "inbox" ? inbox.length : fleet.length;
      const move = (delta: number) => {
        const setAt = focus === "inbox" ? setInboxAt : setFleetAt;
        setAt((current) => Math.min(Math.max(current + delta, 0), Math.max(here - 1, 0)));
      };
      const stop = () => event.preventDefault();

      switch (event.key) {
        case "j":
        case "ArrowDown":
          stop();
          return move(1);
        case "k":
        case "ArrowUp":
          stop();
          return move(-1);
        case "g":
          if (!vim) return;
          stop();
          return (focus === "inbox" ? setInboxAt : setFleetAt)(0);
        case "G":
          stop();
          return (focus === "inbox" ? setInboxAt : setFleetAt)(Math.max(here - 1, 0));
        case "h":
          stop();
          return setFocus("inbox");
        case "l":
          stop();
          return setFocus("fleet");
        case "Tab":
          stop();
          return setFocus((at) => (at === "inbox" ? "fleet" : "inbox"));
        case "Escape":
          stop();
          if (open) return setOpen(null);
          clearRouting();
          return setFocus("inbox");
        case "Enter": {
          stop();
          if (focus === "inbox") {
            const item = inbox[inboxAt];
            if (item) pick(item);
            return;
          }
          if (selected) {
            // Nothing ticked means "the one I am looking at", which is the
            // whole point of arrowing to it.
            const target = ticked.size > 0 ? [...ticked] : [fleet[fleetAt]?.id].filter(Boolean);
            return sendTo(selected.signal.id, target as string[]);
          }
          const agent = fleet[fleetAt];
          if (agent) {
            clearRouting();
            setOpen(agent.id);
          }
          return;
        }
        case " ":
          if (!selected || focus !== "fleet") return;
          stop();
          return toggle(fleet[fleetAt]?.id ?? "");
        case "d":
          if (!selected) return;
          stop();
          return void run(() => api.discard(selected.signal.id), clearRouting);
        case "n": {
          stop();
          const item = selected ?? inbox[inboxAt];
          if (item && item.state === "waiting") {
            void run(() => api.routeSpawn(item.signal.id, snapshot.defaultModel), clearRouting);
          }
          return;
        }
        case "m":
          stop();
          return void run(() => api.setMode(snapshot.mode === "auto" ? "ask" : "auto"));
        case "v":
          stop();
          return toggleVim();
        case "i":
        case "/":
          stop();
          compose.current?.focus();
          return;
        default:
          break;
      }

      // A hint letter sends the selected signal straight to that agent.
      // One keystroke, which is the point of the mode.
      if (vim && selected) {
        const at = HINTS.indexOf(event.key as (typeof HINTS)[number]);
        const agent = at >= 0 ? fleet[at] : undefined;
        if (agent) {
          stop();
          sendTo(selected.signal.id, [agent.id]);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!ready) {
    return (
      <main className="flex h-full items-center justify-center px-6">
        <p className="max-w-[52ch] text-center text-[13px] leading-relaxed text-faint">
          {notice ? (
            <>
              Cannot reach the oxroute daemon.
              <br />
              <span className="tnum text-mid">{notice}</span>
              <br />
              <br />
              Start it with <span className="tnum text-ink">oxrouted</span>.
            </>
          ) : (
            "Connecting to the oxroute daemon…"
          )}
        </p>
      </main>
    );
  }

  return (
    <main className="flex h-full flex-col">
      <Chrome
        snapshot={snapshot}
        waiting={snapshot.inbox.filter((item) => item.state === "waiting").length}
        notice={notice}
        onMode={(mode: Mode) => void run(() => api.setMode(mode))}
        vim={vim}
        onVim={toggleVim}
      />

      <div className="flex min-h-0 flex-1">
        <Inbox
          items={snapshot.inbox}
          agents={snapshot.agents}
          selected={routing}
          onSelect={pick}
          busy={busy}
          cursor={inboxAt}
          active={focus === "inbox"}
          composeRef={compose}
          onNote={(text) => void run(() => api.note(text))}
        />

        {showing ? (
          <AgentPanel
            view={showing}
            busy={busy}
            onBack={() => setOpen(null)}
            onSay={(text) => void run(() => api.say(showing.agent.id, text))}
            onInterrupt={() => void run(() => api.interrupt(showing.agent.id))}
            onFork={() => void run(() => api.fork(showing.agent.id))}
            onRename={(name) => void run(() => api.rename(showing.agent.id, name))}
          />
        ) : (
          <Fleet
            agents={snapshot.agents}
            models={snapshot.models}
            defaultModel={snapshot.defaultModel}
            routing={selected}
            ticked={ticked}
            busy={busy}
            cursor={fleetAt}
            vim={vim && selected !== null}
            onToggle={toggle}
            onOpen={(id) => {
              clearRouting();
              setOpen(id);
            }}
            onSend={() => selected && sendTo(selected.signal.id, [...ticked])}
            onSpawn={(model) =>
              selected &&
              void run(() => api.routeSpawn(selected.signal.id, model), clearRouting)
            }
            onDiscard={() =>
              selected && void run(() => api.discard(selected.signal.id), clearRouting)
            }
          />
        )}
      </div>
    </main>
  );
}
