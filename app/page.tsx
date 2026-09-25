"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { AgentPanel } from "./components/AgentPanel";
import { Chrome } from "./components/Chrome";
import { Fleet } from "./components/Fleet";
import { Help } from "./components/Help";
import { Jump } from "./components/Jump";
import { Inbox } from "./components/Inbox";
import { TaskPanel } from "./components/TaskPanel";
import { api, follow } from "./lib/api";
import { orderTasks } from "./lib/tasks";
import {
  HINTS,
  LETTERS,
  defaultVimMode,
  getVimMode,
  isTyping,
  setVimMode,
  subscribeVimMode,
} from "./lib/keys";
import type { Agent, AgentView, InboxItem, Mode, Snapshot } from "./lib/types";

/** The screen, left to right. h and l step along it. */
const COLUMNS = ["inbox", "fleet", "tasks"] as const;
type Column = (typeof COLUMNS)[number];

const EMPTY: Snapshot = {
  mode: "ask",
  defaultModel: "",
  agents: [],
  archived: [],
  messages: {},
  inbox: [],
  tasks: [],
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
  const [panes, setPanes] = useState<string[]>([]);
  const [paneWidths, setPaneWidths] = useState<number[]>([]);
  const [focusEntry, setFocusEntry] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<string, AgentView>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [ready, setReady] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxWidth, setInboxWidth] = useState(340);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [jump, setJump] = useState(false);
  const [watch, setWatch] = useState(false);
  // Which column the keyboard drives, and where it is in each.
  const [focus, setFocus] = useState<Column>("inbox");
  const [inboxAt, setInboxAt] = useState(0);
  const [fleetAt, setFleetAt] = useState(0);
  const [taskAt, setTaskAt] = useState(0);
  const [tasksDone, setTasksDone] = useState(false);
  const vim = useSyncExternalStore(subscribeVimMode, getVimMode, defaultVimMode);
  const compose = useRef<HTMLTextAreaElement>(null);
  const inboxWidthRef = useRef(340);
  const lastInboxWidth = useRef(340);
  const paneArea = useRef<HTMLDivElement>(null);
  const paneDrag = useRef<{ index: number; x: number; widths: number[] } | null>(null);
  // A signal the inbox cursor should land on as soon as the daemon reports it.
  const landOn = useRef<string | null>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = Number(window.localStorage.getItem("oxroute.inboxWidth"));
      if (saved >= 220 && saved <= 600) {
        setInboxWidth(saved);
        inboxWidthRef.current = saved;
        lastInboxWidth.current = saved;
      }
      setWatch(window.localStorage.getItem("oxroute.watch") === "true");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const setInboxVisible = useCallback((open: boolean) => {
    setInboxOpen(open);
    if (open) {
      setInboxWidth(lastInboxWidth.current);
      inboxWidthRef.current = lastInboxWidth.current;
    }
  }, []);

  const resizeInbox = (width: number) => {
    const next = Math.min(Math.max(width, 0), 600);
    inboxWidthRef.current = next;
    setInboxWidth(next);
    if (next >= 220) lastInboxWidth.current = next;
  };

  const finishInboxResize = () => {
    if (inboxWidthRef.current < 120) {
      setInboxVisible(false);
      return;
    }
    const width = Math.max(inboxWidthRef.current, 220);
    resizeInbox(width);
    window.localStorage.setItem("oxroute.inboxWidth", String(width));
  };

  const say = useCallback((text: string) => {
    setNotice(text);
    // A message that stays forever stops being read.
    window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 6000);
  }, []);

  const reload = useCallback(() => setRevision((current) => current + 1), []);

  const showAgent = useCallback((id: string | null, entry?: number) => {
    setOpen(id);
    // Opening an agent is walking into it: the keys act on it from here.
    if (id) setFocus("fleet");
    setPanes(id ? [id] : []);
    setPaneWidths(id ? [1] : []);
    setFocusEntry(entry ?? null);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("agent", id);
    else url.searchParams.delete("agent");
    if (id && entry !== undefined) url.searchParams.set("entry", String(entry));
    else url.searchParams.delete("entry");
    window.history.pushState(null, "", url);
  }, []);

  const complain = useCallback(
    (error: unknown) => say(error instanceof Error ? error.message : String(error)),
    [say],
  );

  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      const agent = url.searchParams.get("agent");
      setOpen(agent);
      setPanes(agent ? [agent] : []);
      setPaneWidths(agent ? [1] : []);
      const entry = Number(url.searchParams.get("entry"));
      setFocusEntry(entry > 0 ? entry : null);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

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
            setDetails((current) => {
              const view = current[event.agentId];
              return view
                ? { ...current, [event.agentId]: { ...view, agent: { ...view.agent, activity: event.text } } }
                : current;
            });
            break;
          case "timeline":
            if (["received", "said", "asked", "you"].includes(event.entry.kind)) {
              setSnapshot((current) => ({
                ...current,
                messages: { ...current.messages, [event.entry.agentId]: event.entry.text },
              }));
            }
            // Append in place. A full refetch per tool call would make the
            // timeline stutter exactly when there is most to watch.
            setDetails((current) => {
              const view = current[event.entry.agentId];
              if (!view) return current;
              return {
                ...current,
                [event.entry.agentId]: {
                  ...view,
                  timeline: view.timeline.some((entry) => entry.id === event.entry.id)
                    ? view.timeline.map((entry) =>
                        entry.id === event.entry.id ? event.entry : entry,
                      )
                    : [...view.timeline, event.entry],
                },
              };
            });
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

  // The fleet is passed in rather than read from state, so a snapshot that
  // has only just arrived can open the question it brought with it.
  const openRouting = useCallback(
    (item: InboxItem, agents: Agent[]) => {
      showAgent(null);
      setRouting(item.signal.id);
      setTicked(new Set(item.suggested ? [item.suggested] : []));
      setFocus("fleet");
      // Start on the agent this thread already belongs to, if it has one.
      const at = agents.findIndex((a) => a.id === item.suggested);
      setFleetAt(at >= 0 ? at : 0);
    },
    [showAgent],
  );

  useEffect(() => {
    let live = true;
    api.snapshot().then(
      (next) => {
        if (!live) return;
        setSnapshot(next);
        // Nothing to decide, nothing to read: the column earns its width by
        // having something waiting in it.
        if (firstLoad.current) {
          firstLoad.current = false;
          setInboxVisible(next.inbox.some((item) => item.state === "waiting"));
        }
        setReady(true);
        // Something you just typed in is a decision you are about to make, so
        // it opens as one: the enter that adds it lands on the routing
        // question, and the agent's hint letter finishes the job.
        const at = next.inbox.findIndex((item) => item.signal.id === landOn.current);
        if (at < 0) return;
        landOn.current = null;
        compose.current?.blur();
        setInboxAt(at);
        const item = next.inbox[at];
        if (item.state === "waiting") openRouting(item, next.agents);
        else setFocus("inbox");
      },
      (error: unknown) => live && complain(error),
    );
    return () => {
      live = false;
    };
  }, [revision, complain, openRouting, setInboxVisible]);

  useEffect(() => {
    if (panes.length === 0) return;
    let live = true;
    Promise.all(panes.map((id) => api.agent(id))).then(
      (views) => {
        if (!live) return;
        setDetails((current) => ({
          ...current,
          ...Object.fromEntries(views.map((view) => [view.agent.id, view])),
        }));
      },
      (error: unknown) => live && complain(error),
    );
    return () => {
      live = false;
    };
  }, [panes, revision, complain]);

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

  const setUrlAgent = (id: string | null) => {
    setOpen(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("agent", id);
    else url.searchParams.delete("agent");
    url.searchParams.delete("entry");
    window.history.pushState(null, "", url);
  };

  const closePane = (index: number) => {
    const next = panes.filter((_, at) => at !== index);
    setPanes(next);
    setPaneWidths((current) => {
      const widths = [...current];
      const removed = widths.splice(index, 1)[0] ?? 0;
      if (widths.length > 0) widths[Math.min(index, widths.length - 1)] += removed;
      return widths;
    });
    setUrlAgent(next[0] ?? null);
  };

  const forkHere = (index: number, agent: string) =>
    run(async () => {
      const { agent: child } = await api.forkLocal(agent);
      setPanes((current) => [
        ...current.slice(0, index + 1),
        child.id,
        ...current.slice(index + 1),
      ]);
      setPaneWidths((current) => {
        const widths = [...current];
        const split = (widths[index] ?? 1) / 2;
        widths[index] = split;
        widths.splice(index + 1, 0, split);
        return widths;
      });
    });

  const mergePane = (index: number, agent: string) =>
    run(async () => {
      const { agent: parent } = await api.merge(agent);
      setPanes((current) => {
        const parentAt = current.indexOf(parent.id);
        if (parentAt >= 0) return current.filter((_, at) => at !== index);
        return current.map((id, at) => (at === index ? parent.id : id));
      });
      setPaneWidths((current) => {
        const widths = [...current];
        const parentAt = panes.indexOf(parent.id);
        if (parentAt >= 0) {
          const removed = widths.splice(index, 1)[0] ?? 0;
          const adjustedParent = parentAt > index ? parentAt - 1 : parentAt;
          widths[adjustedParent] += removed;
        }
        return widths;
      });
      if (open === agent) setUrlAgent(parent.id);
    });

  const resizePanes = (clientX: number) => {
    const drag = paneDrag.current;
    const width = paneArea.current?.clientWidth ?? 0;
    if (!drag || width === 0) return;
    const total = drag.widths.reduce((sum, value) => sum + value, 0);
    const delta = ((clientX - drag.x) / width) * total;
    const combined = drag.widths[drag.index] + drag.widths[drag.index + 1];
    const minimum = Math.min(0.18, combined / 3);
    const left = Math.min(Math.max(drag.widths[drag.index] + delta, minimum), combined - minimum);
    const next = [...drag.widths];
    next[drag.index] = left;
    next[drag.index + 1] = combined - left;
    setPaneWidths(next);
  };

  // The task column, in the order it is drawn, so the keyboard and the panel
  // are counting the same rows.
  const orderedTasks = orderTasks(snapshot.tasks, panes.at(-1) ?? null);
  const finishedTasks = orderedTasks.filter((task) => task.status === "complete").length;
  const visibleTasks = tasksDone
    ? orderedTasks
    : orderedTasks.filter((task) => task.status !== "complete");

  const selected = snapshot.inbox.find((item) => item.signal.id === routing) ?? null;
  const clearRouting = () => {
    setRouting(null);
    setTicked(new Set());
  };

  // Deciding one signal is rarely deciding only one, so a settled question
  // hands you the next one waiting instead of dropping you back at the
  // fleet. The cursor lands on it the moment the daemon confirms it, which
  // is the same path a signal you typed in takes.
  const settled = useCallback(
    (signalId: string) => () => {
      setRouting(null);
      setTicked(new Set());
      const at = snapshot.inbox.findIndex((item) => item.signal.id === signalId);
      const waiting = snapshot.inbox.filter(
        (item) => item.state === "waiting" && item.signal.id !== signalId,
      );
      const next = waiting.find((item) => snapshot.inbox.indexOf(item) > at) ?? waiting[0];
      if (next) landOn.current = next.signal.id;
    },
    [snapshot.inbox],
  );

  const pick = (item: InboxItem) => {
    const at = snapshot.inbox.findIndex((i) => i.signal.id === item.signal.id);
    if (at >= 0) setInboxAt(at);
    if (item.state !== "waiting") {
      // A settled item is history. Jump to where it went.
      const destination = item.agentIds[0];
      if (destination) {
        clearRouting();
        showAgent(destination);
      }
      return;
    }
    openRouting(item, snapshot.agents);
  };

  // Routing a signal, from wherever the keyboard or the mouse asked.
  const sendTo = useCallback(
    (signalId: string, agentIds: string[]) => {
      if (agentIds.length === 0) return;
      void run(() => api.routeExisting(signalId, agentIds), settled(signalId));
    },
    [run, settled],
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

      // With the hints off this is a mouse interface, so a bare letter must
      // not act: n started an agent and m changed how everything routes.
      // Arrows, enter, escape and tab are nobody's typing, and stay.
      if (!vim && LETTERS.has(event.key)) return;

      const inbox = snapshot.inbox;
      const fleet = showArchived ? snapshot.archived : snapshot.agents;
      const here =
        focus === "inbox" ? inbox.length : focus === "fleet" ? fleet.length : visibleTasks.length;
      const move = (delta: number) => {
        // In an open agent the middle column is a conversation, not a list,
        // so moving in it means reading it.
        if (focus === "fleet" && reading) {
          document.querySelector("[data-transcript]")?.scrollBy({ top: delta * 90 });
          return;
        }
        const setAt =
          focus === "inbox" ? setInboxAt : focus === "fleet" ? setFleetAt : setTaskAt;
        setAt((current) => Math.min(Math.max(current + delta, 0), Math.max(here - 1, 0)));
      };
      // h and l walk the screen: inbox, what you are working on, tasks. A
      // column you step into opens, because a column you cannot see is not
      // somewhere you can be.
      const step = (delta: number) => {
        const next = COLUMNS[Math.min(Math.max(COLUMNS.indexOf(focus) + delta, 0), COLUMNS.length - 1)];
        if (next === "inbox") setInboxVisible(true);
        if (next === "tasks") setTasksOpen(true);
        setFocus(next);
      };
      const stop = () => event.preventDefault();
      // With a pane open the fleet is not on screen, so the keys that act on
      // a card you can no longer see do nothing: reading an agent should not
      // be one letter away from swapping to another one.
      const reading = open !== null && !selected;

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
          stop();
          return (focus === "inbox" ? setInboxAt : setFleetAt)(0);
        case "G":
          stop();
          return (focus === "inbox" ? setInboxAt : setFleetAt)(Math.max(here - 1, 0));
        case "h":
          stop();
          return step(-1);
        case "l":
          stop();
          return step(1);
        case "Tab":
          stop();
          return step(event.shiftKey ? -1 : 1);
        case "Escape":
          stop();
          if (open) return showAgent(null);
          clearRouting();
          return setFocus("inbox");
        case "Enter": {
          stop();
          if (focus === "tasks") {
            // Enter opens whatever the cursor is on, and with an empty
            // column the only thing to open is the box that fills it.
            const row = document.querySelectorAll<HTMLElement>("[data-task-row] button")[taskAt];
            if (row) row.click();
            else document.querySelector<HTMLInputElement>("[data-task-input]")?.focus();
            return;
          }
          // What is in front of you is a conversation, so enter starts
          // typing in it rather than reopening a card you cannot see.
          if (reading) {
            document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus();
            return;
          }
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
            showAgent(agent.id);
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
          return void run(() => api.discard(selected.signal.id), settled(selected.signal.id));
        case "n": {
          if (reading) return;
          stop();
          const item = selected ?? inbox[inboxAt];
          if (item && item.state === "waiting") {
            void run(
              () => api.routeSpawn(item.signal.id, snapshot.defaultModel),
              settled(item.signal.id),
            );
          }
          return;
        }
        case "m":
          stop();
          return void run(() => api.setMode(snapshot.mode === "auto" ? "ask" : "auto"));
        case "v":
          stop();
          return toggleVim();
        case "?":
          stop();
          return setHelp((open) => !open);
        case "f":
          // Everything reachable wears a letter, so nothing here has to be
          // remembered.
          stop();
          return setJump(true);
        case "i":
        case "/":
          stop();
          // The box may be behind a collapsed column; asking for it opens it.
          setInboxVisible(true);
          setFocus("inbox");
          window.requestAnimationFrame(() => compose.current?.focus());
          return;
        default:
          break;
      }

      // A letter goes to the agent it is drawn on: it sends the signal being
      // routed, or, with nothing to route, it opens that agent. One
      // keystroke either way, which is the point of the mode.
      if (vim && !reading) {
        const at = HINTS.indexOf(event.key);
        const agent = at >= 0 ? fleet[at] : undefined;
        if (!agent) return;
        stop();
        if (selected) return sendTo(selected.signal.id, [agent.id]);
        setFleetAt(at);
        showAgent(agent.id);
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
      {help && <Help onClose={() => setHelp(false)} />}
      {jump && <Jump onDone={() => setJump(false)} />}
      <Chrome
        snapshot={snapshot}
        notice={notice}
        onMode={(mode: Mode) => void run(() => api.setMode(mode))}
        inboxOpen={inboxOpen}
        onInbox={() => setInboxVisible(!inboxOpen)}
        vim={vim}
        onVim={toggleVim}
        watch={watch}
        onWatch={() =>
          setWatch((current) => {
            window.localStorage.setItem("oxroute.watch", String(!current));
            return !current;
          })
        }
        tasksOpen={tasksOpen}
        onTasks={() => setTasksOpen((current) => !current)}
        onSearchOpen={showAgent}
        onSearchContinue={(agent) => {
          reload();
          showAgent(agent);
        }}
      />

      <div className="relative flex min-h-0 flex-1">
        {inboxOpen ? (
          <>
            <div className="shrink-0 overflow-hidden" style={{ width: inboxWidth }}>
              <Inbox
                items={snapshot.inbox}
                agents={snapshot.agents}
                selected={routing}
                onSelect={pick}
                busy={busy}
                cursor={inboxAt}
                active={focus === "inbox"}
                composeRef={compose}
                onNote={(text) =>
                  void run(async () => {
                    landOn.current = (await api.note(text)).signal;
                  })
                }
                onCollapse={() => setInboxVisible(false)}
              />
            </div>
            <div
              role="separator"
              aria-label="resize inbox"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  resizeInbox(event.clientX);
                }
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                finishInboxResize();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const change = event.key === "ArrowLeft" ? -20 : 20;
                  const width = Math.min(Math.max(inboxWidth + change, 220), 600);
                  resizeInbox(width);
                  window.localStorage.setItem("oxroute.inboxWidth", String(width));
                }
              }}
              className="group relative w-px shrink-0 cursor-col-resize border-l border-rule outline-none focus:bg-band"
            >
              <span className="absolute inset-y-0 left-[-4px] w-[9px] bg-edge opacity-0 group-hover:opacity-45" />
            </div>
          </>
        ) : null}

        {open ? (
          <div ref={paneArea} className="flex min-w-0 flex-1 overflow-hidden">
            {panes.map((id, index) => {
              const view = details[id];
              return (
                <div
                  key={id}
                  className="flex min-w-0 overflow-hidden"
                  style={{ flexGrow: paneWidths[index] ?? 1, flexBasis: 0 }}
                >
                  {view ? (
                    <AgentPanel
                      view={view}
                      busy={busy}
                      onBack={() => closePane(index)}
                      onSay={(text, images) => void run(() => api.say(id, text, images))}
                      onInterrupt={() => void run(() => api.interrupt(id))}
                      onForkSlack={() => void run(() => api.fork(id))}
                      onForkLocal={() => void forkHere(index, id)}
                      onMerge={
                        view.timeline.some((entry) => entry.kind === "forkedFrom")
                          ? () => void mergePane(index, id)
                          : null
                      }
                      onOpenAgent={showAgent}
                      onRename={(name) => void run(() => api.rename(id, name))}
                      archived={snapshot.archived.some((agent) => agent.id === id)}
                      onArchive={(archived) => {
                        if (archived) closePane(index);
                        void run(() => api.archive(id, archived));
                      }}
                      focusEntry={panes.length === 1 ? focusEntry : null}
                    />
                  ) : (
                    <div className="flex flex-1 items-center justify-center text-[12px] text-faint">
                      Loading session…
                    </div>
                  )}
                  {index < panes.length - 1 && (
                    <div
                      role="separator"
                      aria-label="resize chat panes"
                      aria-orientation="vertical"
                      onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        paneDrag.current = { index, x: event.clientX, widths: [...paneWidths] };
                      }}
                      onPointerMove={(event) => resizePanes(event.clientX)}
                      onPointerUp={(event) => {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                        paneDrag.current = null;
                      }}
                      className="group relative w-[5px] shrink-0 cursor-col-resize border-l border-rule"
                    >
                      <span className="absolute inset-y-0 left-[-2px] w-[5px] bg-edge opacity-0 group-hover:opacity-45" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <Fleet
            agents={showArchived ? snapshot.archived : snapshot.agents}
            archivedCount={snapshot.archived.length}
            showArchived={showArchived}
            onShowArchived={() => {
              setShowArchived((current) => !current);
              setFleetAt(0);
            }}
            models={snapshot.models}
            defaultModel={snapshot.defaultModel}
            messages={snapshot.messages}
            watch={watch && !showArchived && selected === null}
            routing={selected}
            ticked={ticked}
            busy={busy}
            cursor={fleetAt}
            active={focus === "fleet"}
            vim={vim && !jump}
            onToggle={toggle}
            onOpen={(id) => {
              clearRouting();
              showAgent(id);
            }}
            onPin={(id, pinned) => void run(() => api.pin(id, pinned))}
            onSend={() => selected && sendTo(selected.signal.id, [...ticked])}
            onSpawn={(model) =>
              selected &&
              void run(() => api.routeSpawn(selected.signal.id, model), settled(selected.signal.id))
            }
            onDiscard={() =>
              selected && void run(() => api.discard(selected.signal.id), settled(selected.signal.id))
            }
          />
        )}

        {tasksOpen && (
          <TaskPanel
            tasks={snapshot.tasks}
            visible={visibleTasks}
            finished={finishedTasks}
            showDone={tasksDone}
            onShowDone={() => setTasksDone((shown) => !shown)}
            cursor={taskAt}
            active={focus === "tasks"}
            agents={[...snapshot.agents, ...snapshot.archived].filter(
              (agent, index, all) => all.findIndex((item) => item.id === agent.id) === index,
            )}
            currentAgent={panes.at(-1) ?? null}
            busy={busy}
            onClose={() => {
              setTasksOpen(false);
              setFocus("fleet");
            }}
            onCreate={(text, agent) => void run(() => api.createTask(text, agent))}
            onUpdate={(task) => void run(() => api.updateTask(task))}
            onDelete={(id) => void run(() => api.deleteTask(id))}
          />
        )}
      </div>
    </main>
  );
}
