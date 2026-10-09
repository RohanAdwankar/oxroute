"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { AgentPanel } from "./components/AgentPanel";
import { AgentPicker, PaneWorkspace } from "./components/PaneWorkspace";
import { paneIds, readPanes, syncPanes } from "./lib/panes";
import { Chrome } from "./components/Chrome";
import { Fleet } from "./components/Fleet";
import { FrontendVersion } from "./components/FrontendVersion";
import { Help } from "./components/Help";
import { Settings } from "./components/Settings";
import { TaskComposer } from "./components/TaskComposer";
import { Jump } from "./components/Jump";
import { Inbox } from "./components/Inbox";
import { TaskPanel } from "./components/TaskPanel";
import { BoardView } from "./components/BoardView";
import { api, follow } from "./lib/api";
import { inboxRows } from "./lib/inbox";
import { taskRows } from "./lib/tasks";
import { acceptsFileDrop } from "./lib/uploads";
import {
  HINTS,
  LETTERS,
  defaultVimMode,
  theme,
  verbose,
  graph,
  wrap,
  scalePanes,
  getVimMode,
  isTyping,
  setVimMode,
  subscribeVimMode,
} from "./lib/keys";
import type { Agent, AgentView, InboxItem, Mode, Snapshot, TaskItem } from "./lib/types";

/** The screen, left to right. h and l step along it. */
const COLUMNS = ["inbox", "fleet", "tasks"] as const;
type Column = (typeof COLUMNS)[number];

const EMPTY: Snapshot = {
  mode: "ask",
  defaultModel: "",
  agents: [],
  archived: [],
  messages: {},
  paneLinks: {},
  inbox: [],
  tasks: [],
  taskNotes: [],
  tags: {},
  boards: [],
  sources: [],
  models: [],
  backends: [],
};

function linkedPanes(id: string, links: Record<string, string>): string[] {
  let root = id;
  const seen = new Set([root]);
  while (links[root] && !seen.has(links[root])) {
    root = links[root];
    seen.add(root);
  }
  const group = [root];
  for (let at = 0; at < group.length; at++) {
    group.push(...Object.keys(links).filter((child) => links[child] === group[at]).sort());
  }
  return group;
}

/**
 * The whole interface.
 *
 * Agent data comes from the daemon; pane arrangements are browser-local.
 * The event stream bumps a revision counter and every read refetches it,
 * so decisions made in the TUI appear here without either surface knowing
 * the other exists.
 */
export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [revision, setRevision] = useState(0);
  const [routing, setRouting] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [panes, setPanes] = useState<string[]>([]);
  const customPanes = useRef(false);
  const [focusEntry, setFocusEntry] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<string, AgentView>>({});
  const requests = useRef(new Map<string, Promise<AgentView>>());
  const warmed = useRef(new Set<string>());
  const loadAgent = useCallback((id: string) => {
    const pending = requests.current.get(id);
    if (pending) return pending;
    const request = api.agent(id).then((view) => {
      setDetails((current) => ({ ...current, [id]: view }));
      return view;
    }).finally(() => requests.current.delete(id));
    requests.current.set(id, request);
    return request;
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingTasks, setSavingTasks] = useState<Record<string, TaskItem>>({});
  const [creatingTasks, setCreatingTasks] = useState<Record<string, TaskItem & { existing: Set<string> }>>({});
  const [showArchived, setShowArchived] = useState(false);
  const [ready, setReady] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxWidth, setInboxWidth] = useState(340);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [jump, setJump] = useState(false);
  const [settings, setSettings] = useState(false);
  // Which board the main column shows when no agent is open. Null is the fleet.
  const [boardId, setBoardId] = useState<string | null>(null);
  // Which column the keyboard drives, and where it is in each.
  const [focus, setFocus] = useState<Column>("inbox");
  const [inboxAt, setInboxAt] = useState(0);
  const [fleetAt, setFleetAt] = useState(0);
  const [taskAt, setTaskAt] = useState(0);
  const [inboxDone, setInboxDone] = useState(false);
  const [tasksDone, setTasksDone] = useState(false);
  const [taskQuery, setTaskQuery] = useState("");
  const [shownTask, setShownTask] = useState<string | null>(null);
  /// Finished work you have said "not yet" to, answered in its composer.
  const [correcting, setCorrecting] = useState<TaskItem | null>(null);
  const [taskWidth, setTaskWidth] = useState(430);
  const vim = useSyncExternalStore(subscribeVimMode, getVimMode, defaultVimMode);
  const tone = useSyncExternalStore(theme.subscribe, theme.get, theme.fallback);
  const loud = useSyncExternalStore(verbose.subscribe, verbose.get, verbose.fallback);
  const drawn = useSyncExternalStore(graph.subscribe, graph.get, graph.fallback);
  const wrapped = useSyncExternalStore(wrap.subscribe, wrap.get, wrap.fallback);
  const scaled = useSyncExternalStore(scalePanes.subscribe, scalePanes.get, scalePanes.fallback);
  const compose = useRef<HTMLTextAreaElement>(null);
  const inboxWidthRef = useRef(340);
  const lastInboxWidth = useRef(340);
  const paneLinks = useRef<Record<string, string>>({});
  // A signal the inbox cursor should land on as soon as the daemon reports it.
  const landOn = useRef<string | null>(null);
  const firstLoad = useRef(true);
  /// Digits typed before a motion, and a lone g waiting for its pair.
  const typed = useRef("");
  const pendingG = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = Number(window.localStorage.getItem("oxroute.inboxWidth"));
      if (saved >= 220 && saved <= 600) {
        setInboxWidth(saved);
        inboxWidthRef.current = saved;
        lastInboxWidth.current = saved;
      }
      setTasksOpen(window.localStorage.getItem("oxroute.tasks") === "true");
      const tasksAt = Number(window.localStorage.getItem("oxroute.taskWidth"));
      if (tasksAt >= 260) setTaskWidth(tasksAt);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  /// A column you left open is one you were using; it is still open when
  /// you come back.
  const showTasks = useCallback((open: boolean) => {
    setTasksOpen(open);
    window.localStorage.setItem("oxroute.tasks", String(open));
  }, []);

  const setInboxVisible = useCallback((open: boolean) => {
    setInboxOpen(open);
    if (open) {
      setInboxWidth(lastInboxWidth.current);
      inboxWidthRef.current = lastInboxWidth.current;
    }
  }, []);

  /// How wide the task column is, within what is readable and what fits.
  const resizeTasks = (width: number) => {
    const next = Math.min(Math.max(width, 260), Math.max(window.innerWidth - 360, 260));
    setTaskWidth(next);
    return next;
  };

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

  useEffect(() => {
    const stopNavigation = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer || !acceptsFileDrop(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === "drop") say("Drop images on a conversation to attach them");
    };
    window.addEventListener("dragover", stopNavigation);
    window.addEventListener("drop", stopNavigation);
    return () => {
      window.removeEventListener("dragover", stopNavigation);
      window.removeEventListener("drop", stopNavigation);
    };
  }, [say]);

  const reload = useCallback(() => setRevision((current) => current + 1), []);

  const showAgent = useCallback((id: string | null, entry?: number) => {
    setOpen(id);
    // Opening an agent is walking into it: the keys act on it from here.
    if (id) setFocus("fleet");
    const saved = id ? readPanes(id) : null;
    customPanes.current = saved !== null;
    const group = saved ? paneIds(saved) : id ? linkedPanes(id, paneLinks.current) : [];
    setPanes(group);
    setFocusEntry(entry ?? null);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("agent", id);
    else url.searchParams.delete("agent");
    if (id && entry !== undefined) url.searchParams.set("entry", String(entry));
    else url.searchParams.delete("entry");
    window.history.pushState(null, "", url);
  }, []);

  const showBoard = useCallback(
    (id: string | null) => {
      showAgent(null);
      setRouting(null);
      setTicked(new Set());
      setBoardId(id);
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("board", id);
      else url.searchParams.delete("board");
      window.history.replaceState(null, "", url);
    },
    [showAgent],
  );

  const complain = useCallback(
    (error: unknown) => say(error instanceof Error ? error.message : String(error)),
    [say],
  );

  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      setBoardId(url.searchParams.get("board"));
      const agent = url.searchParams.get("agent");
      setOpen(agent);
      // Arriving at an agent is the same as walking into one: the keys act
      // on the conversation in front of you, not on the column beside it.
      if (agent) setFocus("fleet");
      const saved = agent ? readPanes(agent) : null;
      customPanes.current = saved !== null;
      setPanes(saved ? paneIds(saved) : agent ? [agent] : []);
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
        paneLinks.current = next.paneLinks ?? {};
        setSnapshot(next);
        const selectedAgent = new URL(window.location.href).searchParams.get("agent");
        if (selectedAgent && !customPanes.current) {
          const group = linkedPanes(selectedAgent, next.paneLinks ?? {});
          setPanes((current) => current.length === group.length && current.every((id, at) => id === group[at]) ? current : group);
        }
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
        const landed = inboxRows(next.inbox, false).findIndex(
          (row) => row.kind === "item" && row.item.signal.id === landOn.current,
        );
        if (landed < 0) return;
        landOn.current = null;
        compose.current?.blur();
        setInboxAt(landed);
        const row = inboxRows(next.inbox, false)[landed];
        if (row.kind === "item" && row.item.state === "waiting") openRouting(row.item, next.agents);
        else setFocus("inbox");
      },
      (error: unknown) => live && complain(error),
    );
    return () => {
      live = false;
    };
  }, [revision, complain, openRouting, setInboxVisible]);

  // Active cards should already have their conversation when opened.
  useEffect(() => {
    for (const agent of snapshot.agents) {
      if (warmed.current.has(agent.id)) continue;
      warmed.current.add(agent.id);
      void loadAgent(agent.id).catch(() => warmed.current.delete(agent.id));
    }
  }, [snapshot.agents, loadAgent]);

  useEffect(() => {
    if (panes.length === 0) return;
    let live = true;
    // One pane at a time: a session that is a moment from existing -- just
    // spawned, or just forked -- must not blank the pane beside it. A pane
    // that could not be read keeps asking, because the sync that would have
    // asked again may never come: a dropped event stream leaves the pane
    // saying "Loading session…" for as long as you look at it.
    const fetchPanes = async () => {
      for (let wait = 500; live; wait = Math.min(wait * 2, 8000)) {
        const answers = await Promise.allSettled(panes.map(loadAgent));
        if (!live) return;
        const views = answers.flatMap((answer) =>
          answer.status === "fulfilled" ? [answer.value] : [],
        );
        if (views.length === panes.length) return;
        await new Promise((again) => setTimeout(again, wait));
      }
    };
    void fetchPanes();
    return () => {
      live = false;
    };
  }, [panes, revision, complain, loadAgent]);

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

  // Task edits are independent. Show each edit immediately and lock only
  // that row until it is saved; snapshots cannot erase an in-flight edit.
  const updateTask = async (task: TaskItem, note?: string, approved?: boolean) => {
    setSavingTasks((current) => ({ ...current, [task.id]: task }));
    try {
      const saved = await api.updateTask(task, note, approved);
      setSnapshot((current) => ({
        ...current,
        tasks: current.tasks.map((item) => item.id === saved.id ? saved : item),
      }));
      reload();
    } catch (error) {
      complain(error);
    } finally {
      setSavingTasks((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  };

  /// Filing a task from a composer. It goes to the bottom of a long list,
  /// so the list has to be open and looking at it, or nothing happened as
  /// far as anyone can see.
  const file = async (text: string, images: File[], agentId = "") => {
    const id = crypto.randomUUID();
    const at = Date.now() / 1000;
    const pending = {
      id, text, agentId, status: "incomplete", blockedByTaskId: "",
      images: [], createdAt: at, updatedAt: at,
      existing: new Set(snapshot.tasks.map((task) => task.id)),
    } satisfies TaskItem & { existing: Set<string> };
    setCreatingTasks((current) => ({ ...current, [id]: pending }));
    showTasks(true);
    setShownTask(id);
    try {
      const task = await api.createTaskWithImages(text, agentId, images);
      setSnapshot((current) => ({
        ...current, tasks: [...current.tasks.filter((item) => item.id !== task.id), task],
      }));
      setShownTask(task.id);
      reload();
      return true;
    } catch (error) {
      complain(error);
      return false;
    } finally {
      setCreatingTasks((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const sendMessage = async (id: string, text: string, images: File[], queued: boolean, diffs: import("./lib/drafts").DiffQuote[] = []) => {
    try {
      await api.say(id, text, images, queued, diffs);
    } catch (error) {
      complain(error);
      return false;
    }
    // The acknowledgement and event stream may arrive in either order.
    await loadAgent(id).catch(complain);
    reload();
    return true;
  };

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
    setUrlAgent(next[0] ?? null);
  };

  /// Put a session in its own pane beside the one at `index`, sharing that
  /// pane's space with it.
  const placeBeside = useCallback((index: number, agent: string) => {
    setPanes((current) =>
      current.includes(agent)
        ? current
        : [...current.slice(0, index + 1), agent, ...current.slice(index + 1)],
    );
  }, []);

  const forkBeside = (index: number, agent: string) =>
    run(async () => {
      const { agent: child } = await api.forkInChat(agent);
      placeBeside(index, child.id);
    });

  /// A separate source thread is a separate card on the home screen.
  const forkOut = (agent: string) =>
    run(async () => {
      const { agent: child } = await api.fork(agent);
      showAgent(child.id);
    });

  const mergePane = (index: number, agent: string) =>
    run(async () => {
      const { agent: parent } = await api.merge(agent);
      setPanes((current) => {
        const parentAt = current.indexOf(parent.id);
        if (parentAt >= 0) return current.filter((_, at) => at !== index);
        return current.map((id, at) => (at === index ? parent.id : id));
      });
      if (open === agent) setUrlAgent(parent.id);
    });

  const choosePanes = (ids: string[]) => {
    const key = open ?? ids[0];
    if (key) {
      const tree = syncPanes(readPanes(key), ids);
      if (tree) localStorage.setItem(`oxroute.panes.${key}`, JSON.stringify(tree));
      else localStorage.removeItem(`oxroute.panes.${key}`);
    }
    customPanes.current = true;
    setPanes(ids);
    if (!open || !ids.length) setUrlAgent(ids[0] ?? null);
  };

  // Both columns as they are drawn, so the keyboard counts the rows on
  // screen rather than the data behind them.
  const rows = inboxRows(snapshot.inbox, inboxDone);

  const pendingTasks = Object.values(creatingTasks);
  for (const task of snapshot.tasks) {
    const at = pendingTasks.findIndex((pending) => !pending.existing.has(task.id) &&
      pending.text === task.text && pending.agentId === task.agentId);
    if (at >= 0) pendingTasks.splice(at, 1);
  }
  const taskItems = [...snapshot.tasks.map((task) => savingTasks[task.id] ?? task), ...pendingTasks];
  const taskSearch = taskQuery.trim().toLowerCase();
  const taskNames = new Map([...snapshot.agents, ...snapshot.archived].map(agent => [agent.id, agent.name]));
  const taskMatches = taskItems.filter(task => !taskSearch || `${task.text} ${taskNames.get(task.agentId) ?? ""}`.toLowerCase().includes(taskSearch));
  const tasks = taskRows(taskMatches, tasksDone || !!taskSearch);

  const selected = snapshot.inbox.find((item) => item.signal.id === routing) ?? null;
  const activeBoard = snapshot.boards.find((board) => board.id === boardId) ?? null;
  const knownTags = [...new Set(Object.values(snapshot.tags).flat())].sort();
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

  const chooseAgent = (id: string) => {
    clearRouting();
    showAgent(id);
  };

  const pick = (item: InboxItem) => {
    const at = rows.findIndex((row) => row.kind === "item" && row.item.signal.id === item.signal.id);
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

      // A board owns the main column. The fleet's keys would drive cards
      // nobody can see, so only the ones that reach elsewhere still work.
      if (
        activeBoard &&
        !selected &&
        !open &&
        focus === "fleet" &&
        !["h", "l", "Tab", "Escape", "i", "/", "m", "v", "?", "f"].includes(event.key)
      ) {
        return;
      }

      const fleet = showArchived ? snapshot.archived : snapshot.agents;
      const here =
        focus === "inbox" ? rows.length : focus === "fleet" ? fleet.length : tasks.length;
      const move = (delta: number) => {
        // In an open agent the middle column is a conversation, not a list,
        // so moving in it means reading it.
        if (focus === "fleet" && reading) {
          document.querySelector('[data-pane-active="true"] [data-transcript]')?.scrollBy({ top: delta * 90 });
          return;
        }
        const setAt =
          focus === "inbox" ? setInboxAt : focus === "fleet" ? setFleetAt : setTaskAt;
        setAt((current) => Math.min(Math.max(current + delta, 0), Math.max(here - 1, 0)));
      };
      /// The top or the bottom of whatever is in front of you.
      const toEnd = (way: number) => {
        if (focus === "fleet" && reading) {
          const node = document.querySelector('[data-pane-active="true"] [data-transcript]');
          node?.scrollTo({ top: way < 0 ? 0 : node.scrollHeight, behavior: "smooth" });
          return;
        }
        const setAt =
          focus === "inbox" ? setInboxAt : focus === "fleet" ? setFleetAt : setTaskAt;
        setAt(way < 0 ? 0 : Math.max(here - 1, 0));
      };

      // h and l walk the screen: inbox, what you are working on, tasks. A
      // column you step into opens, because a column you cannot see is not
      // somewhere you can be.
      const step = (delta: number) => {
        const next = COLUMNS[Math.min(Math.max(COLUMNS.indexOf(focus) + delta, 0), COLUMNS.length - 1)];
        if (next === "inbox") setInboxVisible(true);
        if (next === "tasks") showTasks(true);
        setFocus(next);
      };
      const stop = () => event.preventDefault();
      /// A count typed before a motion, vim's way: 5j is five of them. It
      /// is taken once and forgotten, so it never leaks into the next key.
      const count = Math.max(Number(typed.current) || 1, 1);
      const takeCount = () => {
        typed.current = "";
        return count;
      };
      // With a pane open the fleet is not on screen, so the keys that act on
      // a card you can no longer see do nothing: reading an agent should not
      // be one letter away from swapping to another one.
      const reading = open !== null && !selected;

      // Digits are a count waiting for the motion they belong to -- and
      // only in the mode that has motions.
      if (vim && /^[0-9]$/.test(event.key) && (event.key !== "0" || typed.current)) {
        stop();
        typed.current += event.key;
        return;
      }
      const wasG = pendingG.current;
      pendingG.current = false;

      switch (event.key) {
        case "j":
        case "ArrowDown":
          stop();
          return move(takeCount());
        case "k":
        case "ArrowUp":
          stop();
          return move(-takeCount());
        case "g":
          stop();
          // gg, as in vim: one g waits to see whether a second follows.
          if (!wasG) {
            pendingG.current = true;
            return;
          }
          typed.current = "";
          return toEnd(-1);
        case "J":
        case "K": {
          if (focus !== "tasks") return;
          stop();
          const row = tasks[taskAt];
          if (row?.kind !== "task") return;
          const up = event.key === "K";
          // The task it lands after: the one two places up when moving up,
          // and the one immediately below when moving down.
          const live = tasks.filter((entry) => entry.kind === "task").map((entry) => entry.task);
          const at = live.findIndex((task) => task.id === row.task.id);
          const to = up ? at - 1 : at + 1;
          if (to < 0 || to >= live.length) return;
          const after = up ? live[to - 1]?.id : live[to].id;
          setTaskAt((current) => current + (up ? -1 : 1));
          return void run(() => api.moveTask(row.task.id, after));
        }
        case "G":
          stop();
          typed.current = "";
          return toEnd(1);
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
            const row = tasks[taskAt];
            if (row?.kind === "band") return setTasksDone((shown) => !shown);
            // The band is a row but not a task, so the two counts differ.
            const nth = tasks.slice(0, taskAt).filter((entry) => entry.kind === "task").length;
            document.querySelectorAll<HTMLElement>("[data-task-open]")[nth]?.click();
            return;
          }
          // What is in front of you is a conversation, so enter starts
          // typing in it rather than reopening a card you cannot see. Only
          // when the middle column has the emphasis: an open pane must not
          // answer for a column you have moved away from.
          if (focus === "fleet" && reading) {
            document.querySelector<HTMLTextAreaElement>('[data-pane-active="true"] [data-composer]')?.focus();
            return;
          }
          if (focus === "inbox") {
            const row = rows[inboxAt];
            // The band over the settled items opens; an item is a decision.
            if (row?.kind === "band") return setInboxDone((shown) => !shown);
            if (row) pick(row.item);
            return;
          }
          if (selected) {
            // Nothing ticked means "the one I am looking at", which is the
            // whole point of arrowing to it.
            const target = ticked.size > 0 ? [...ticked] : [fleet[fleetAt]?.id].filter(Boolean);
            return sendTo(selected.signal.id, target as string[]);
          }
          const agent = fleet[fleetAt];
          if (agent) chooseAgent(agent.id);
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
          const under = rows[inboxAt];
          const item = selected ?? (under?.kind === "item" ? under.item : undefined);
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
        chooseAgent(agent.id);
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
      <FrontendVersion />
      {help && <Help onClose={() => setHelp(false)} />}
      {settings && (
        <Settings
          theme={tone}
          onTheme={theme.set}
          verbose={loud}
          onVerbose={verbose.set}
          graph={drawn}
          onGraph={graph.set}
          wrap={wrapped}
          onWrap={wrap.set}
          scalePanes={scaled}
          onScalePanes={scalePanes.set}
          vim={vim}
          onVim={setVimMode}
          onClose={() => setSettings(false)}
        />
      )}
      {jump && <Jump onDone={() => setJump(false)} />}
      <Chrome
        panes={<AgentPicker agents={[...snapshot.agents, ...snapshot.archived]} selected={panes} onSelect={choosePanes} />}
        snapshot={snapshot}
        notice={notice}
        onMode={(mode: Mode) => void run(() => api.setMode(mode))}
        inboxOpen={inboxOpen}
        onInbox={() => setInboxVisible(!inboxOpen)}
        tasksOpen={tasksOpen}
        onTasks={() => showTasks(!tasksOpen)}
        onSettings={() => setSettings(true)}
        activeBoard={activeBoard?.id ?? null}
        onBoard={showBoard}
        onNewBoard={() =>
          void run(async () => {
            const board = await api.createBoard({});
            showBoard(board.id);
          })
        }
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
                rows={rows}
                onShowDone={() => setInboxDone((shown) => !shown)}
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
          <PaneWorkspace key={open} workspace={open} ids={panes} keyboard={vim && focus === "fleet" && !selected} onActivate={() => setFocus("fleet")} onCustomize={() => { customPanes.current = true; }} onClose={id => choosePanes(panes.filter(pane => pane !== id))}>
            {(id, index, paneHandle) => {
              const agent = [...snapshot.agents, ...snapshot.archived].find((agent) => agent.id === id);
              const view = details[id] ?? (agent ? {
                agent,
                timeline: [],
                delivery: agent.status === "working" ? "restart" as const : "start" as const,
              } : undefined);
              return (
                <div
                  key={id}
                  className="flex min-w-0 overflow-hidden"
                  style={{ flex: 1 }}
                >
                  {view ? (
                    <AgentPanel
                      paneHandle={paneHandle}
                      view={view}
                      initialPreview={details[id] ? undefined : snapshot.messages[id] ?? ""}
                      can={
                        snapshot.backends.find((b) => b.backend === view.agent.backend) ?? {
                          backend: view.agent.backend,
                          fork: false,
                          merge: false,
                        }
                      }
                      busy={busy}
                      onBack={() => showAgent(null)}
                      onSay={(text, images, queued, diffs) => sendMessage(id, text, images, queued, diffs)}
                      onTask={(text, images) => file(text, images, id)}
                      correcting={correcting?.agentId === id ? correcting : null}
                      onStopCorrecting={() => setCorrecting(null)}
                      onCorrect={(text, images, queued) => {
                        const task = correcting;
                        setCorrecting(null);
                        if (task) void run(() => api.correctTask(task.id, text, images, queued));
                      }}
                      onSendDiagram={(edits, note, queued) =>
                        void run(async () => {
                          await api.sendDiagram(id, edits, note, queued);
                          say(queued ? "Queued the drawn change" : "Sent the drawn change");
                        })
                      }
                      onCreateDiagram={(about) =>
                        void run(() => api.createDiagram(id, about))
                      }
                      say={say}
                      tags={snapshot.tags[id] ?? []}
                      knownTags={knownTags}
                      onTag={(change) => void run(() => api.tag(id, change))}
                      onReact={(entry, reaction) => void run(() => api.react(entry, reaction))}
                      models={snapshot.models}
                      onModel={(model) => void run(() => api.setModel(id, model))}
                      onInterrupt={() => void run(() => api.interrupt(id))}
                      onFork={() => void forkBeside(index, id)}
                      onForkBeside={() => void forkOut(id)}
                      onMerge={
                        view.timeline.some((entry) => entry.kind === "forkedFrom")
                          ? () => void mergePane(index, id)
                          : null
                      }
                      onOpenAgent={(target) =>
                        // A fork and its parent are usually side by side by
                        // the time one links to the other. Following the
                        // link should not throw that away.
                        panes.includes(target) ? setUrlAgent(target) : showAgent(target)
                      }
                      onRename={(name) => void run(() => api.rename(id, name))}
                      archived={snapshot.archived.some((agent) => agent.id === id)}
                      onArchive={(archived) => {
                        if (archived) closePane(index);
                        void run(() => api.archive(id, archived));
                      }}
                      focusEntry={panes.length === 1 ? focusEntry : null}
                      verbose={loud === "on"}
                    />
                  ) : (
                    <div className="flex flex-1 items-center justify-center text-[12px] text-faint">
                      Loading session…
                    </div>
                  )}
                </div>
              );
            }}
          </PaneWorkspace>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {activeBoard && !selected ? (
              <BoardView
                key={activeBoard.id}
                board={activeBoard}
                snapshot={snapshot}
                revision={revision}
                busy={busy}
                run={run}
                say={say}
                onDeleted={() => showBoard(null)}
                onOpenAgent={(id) => {
                  clearRouting();
                  showAgent(id);
                }}
              />
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
                tags={snapshot.tags}
                routing={selected}
                ticked={ticked}
                busy={busy}
                cursor={fleetAt}
                active={focus === "fleet"}
                vim={vim && !jump}
                onToggle={toggle}
                onOpen={chooseAgent}
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
            <TaskComposer
              busy={busy}
              onTask={(text, images) => file(text, images)}
            />
          </div>
        )}

        {tasksOpen && (
          <>
            <div
              role="separator"
              aria-label="resize tasks"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  resizeTasks(window.innerWidth - event.clientX);
                }
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                window.localStorage.setItem("oxroute.taskWidth", String(taskWidth));
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const width = resizeTasks(taskWidth + (event.key === "ArrowLeft" ? 20 : -20));
                window.localStorage.setItem("oxroute.taskWidth", String(width));
              }}
              className="group relative w-px shrink-0 cursor-col-resize outline-none focus:bg-band"
            >
              <span className="absolute inset-y-0 left-[-4px] w-[9px] bg-edge opacity-0 group-hover:opacity-45" />
            </div>
            <div className="shrink-0 overflow-hidden" style={{ width: taskWidth }}>
          <TaskPanel
            tasks={taskItems}
            rows={tasks}
            query={taskQuery}
            onSearch={query => { setTaskQuery(query); setTaskAt(0); setFocus("tasks"); }}
            notes={snapshot.taskNotes}
            onShowDone={() => setTasksDone((shown) => !shown)}
            cursor={taskAt}
            active={focus === "tasks"}
            shown={shownTask}
            graph={drawn === "on"}
            agents={snapshot.agents}
            named={[...snapshot.agents, ...snapshot.archived].filter(
              (agent, index, all) => all.findIndex((item) => item.id === agent.id) === index,
            )}
            busy={(id) => busy || id in savingTasks || id in creatingTasks}
            onUpdate={(task, note, approved) => void updateTask(task, note, approved)}
            onOpenAgent={(id) => {
              clearRouting();
              showAgent(id);
            }}
            onCorrect={(task) => {
              if (!task.agentId) return say("Nobody has this task to correct");
              setCorrecting(task);
              if (!panes.includes(task.agentId)) showAgent(task.agentId);
            }}
            onHandOff={(task, fork) =>
              void run(() => api.handOffTask(task.id, fork, snapshot.defaultModel))
            }
            onDelete={(id) => void run(() => api.deleteTask(id))}
          />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
