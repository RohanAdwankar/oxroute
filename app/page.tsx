"use client";

import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArtifactRoot, TaskLinks } from "./components/Markdown";
import { EmbeddedReviews, DecisionReferences, ConversationNavigation, ConversationCards, ConversationReferences, CoordinationTitles } from "./components/FocusContext";
import { receiveDraft, type DiffQuote } from "./lib/drafts";
import { titleQuote } from "./lib/title-quotes";
import { TaskActions } from "./components/TaskReference";

import { ArchiveAgent } from "./components/ArchiveAgent";
import { AgentPanel } from "./components/AgentPanel";
import { BrowserPane, browserApi, type BrowserInfo } from "./components/BrowserPane";
import { TerminalPane, terminalApi, type TerminalInfo } from "./components/TerminalPane";
import { AgentPicker, PaneWorkspace } from "./components/PaneWorkspace";
import { dockPanes, paneIds, readPanes, removePane, syncPanes, writePanes, type PaneLayout } from "./lib/panes";
import { usePaneTransfer, type PaneOffer } from "./lib/pane-transfer";
import { Chrome } from "./components/Chrome";
import { SessionTabs } from "./components/SessionTabs";
import { Icon } from "./components/Icon";
import { HomeActions } from "./components/HomeActions";
import { Fleet } from "./components/Fleet";
import { FrontendVersion } from "./components/FrontendVersion";
import { Help } from "./components/Help";
import { Settings } from "./components/Settings";
import { TaskComposer } from "./components/TaskComposer";
import { Jump } from "./components/Jump";
import { Inbox } from "./components/Inbox";
import { TaskPanel } from "./components/TaskPanel";
import { FocusDecisionDeck } from "./components/FocusDecisionDeck";
import { BoardView } from "./components/BoardView";
import { captureClientFailures } from "./lib/client-failures";
import { api, follow } from "./lib/api";
import { useAgentViews } from "./lib/agent-views";
import { preloadReview, reviewEndpoint } from "./lib/reviews";
import { inboxRows } from "./lib/inbox";
import { taskSubtree, taskAncestors, taskRows, focusDecisions } from "./lib/tasks";
import { acceptsFileDrop } from "./lib/uploads";
import {
  HINTS,
  LETTERS,
  defaultVimMode,
  theme,
  verbose,
  graph,
  wrap,
  nextActionLayout,
  defaultWindowTasks,
  scalePanes,
  minimumPaneScale,
  terminalFontScale,
  getVimMode,
  isTyping,
  setVimMode,
  subscribeVimMode,
} from "./lib/keys";
import type { FocusData, Agent, AgentView, DaemonEvent, Entry, InboxItem, Mode, Snapshot, TaskItem } from "./lib/types";

/** Preserve task roster identity while activity/status fields stream past. */
function useTaskAgents(agents: Agent[]) {
  const roster = new Map<string, Pick<Agent, "id" | "name">>();
  for (const { id, name } of agents) if (!roster.has(id)) roster.set(id, { id, name });
  const names = JSON.stringify([...roster.values()]);
  return useMemo(() => JSON.parse(names) as Pick<Agent, "id" | "name">[], [names]);
}

/** The screen, left to right. h and l step along it. */
const COLUMNS = ["inbox", "fleet", "tasks"] as const;
type Column = (typeof COLUMNS)[number];

const EMPTY: Snapshot = {
  mode: "ask",
  nextActionMode: "ask",
  nextActionSuggestions: true,
  automaticTitles: true,
  automaticTags: false,
  recommendationLearning: true,
  defaultModel: "",
  artifactRoot: "",
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

const MESSAGE_KINDS = new Set<Entry["kind"]>(["received", "said", "asked", "you", "coordination"]);

function streamedSnapshot(snapshot: Snapshot, event: DaemonEvent): Snapshot {
  if (event.type === "progress") return {
    ...snapshot,
    agents: snapshot.agents.map(agent => agent.id === event.agentId ? { ...agent, activity: event.text } : agent),
  };
  if (event.type === "timeline" && MESSAGE_KINDS.has(event.entry.kind)) return {
    ...snapshot,
    messages: { ...snapshot.messages, [event.entry.agentId]: event.entry.text },
  };
  return snapshot;
}

function archivedSnapshot(snapshot: Snapshot, agent: Agent, archived: boolean): Snapshot {
  return { ...snapshot,
    agents: [...snapshot.agents.filter(item => item.id !== agent.id), ...(!archived ? [agent] : [])],
    archived: [...snapshot.archived.filter(item => item.id !== agent.id), ...(archived ? [agent] : [])],
  };
}

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
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusAgentId,setFocusAgentId]=useState<string|null>(null);
  const [focusError,setFocusError]=useState("");
  const [focusRetry,setFocusRetry]=useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [tabIds, setTabIds] = useState<string[]>(() => {
    try {
      if (new URLSearchParams(location.search).has("transfer")) return [];
      const saved: unknown = JSON.parse(sessionStorage.getItem("oxroute.sessionTabs") ?? "[]");
      return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === "string"))] : [];
    } catch { return []; }
  });
  if (open && !focusOpen && !tabIds.includes(open)) setTabIds([...tabIds, open]);
  useEffect(() => { sessionStorage.setItem("oxroute.sessionTabs", JSON.stringify(tabIds)); }, [tabIds]);
  const [panes, setPanes] = useState<string[]>([]);
  const [paneRevision, setPaneRevision] = useState(0);
  const customPanes = useRef(false);
  const [focusEntry, setFocusEntry] = useState<number | null>(null);
  const [details, setDetails] = useAgentViews(panes);
  const creatingAgents = useRef(new Map<string, Agent>());
  const archivingAgents = useRef(new Map<string, { agent: Agent; archived: boolean; request: Promise<Snapshot> }>());
  const pendingSnapshot = useCallback((snapshot: Snapshot) => {
    let next = { ...snapshot, agents: [...snapshot.agents] };
    for (const [id, agent] of creatingAgents.current) {
      if (![...next.agents, ...next.archived].some(saved => saved.id === id)) next.agents.push(agent);
    }
    for (const change of archivingAgents.current.values()) next = archivedSnapshot(next, change.agent, change.archived);
    return next;
  }, []);
  const requests = useRef(new Map<string, { promise: Promise<AgentView>; updates: Map<number, Entry>; reactions: Map<number, string> }>());
  const snapshotUpdates = useRef<Map<string, DaemonEvent> | null>(null);
  const taskNotesRequest = useRef<Promise<void> | null>(null);
  const taskNotesDirty = useRef(false);
  const [taskNotesRevision, setTaskNotesRevision] = useState(0);
  const warmed = useRef(new Set<string>());
  const warmQueue = useRef<string[]>([]);
  const warming = useRef(0);
  const warmPaused = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchVisibility = useCallback((open: boolean) => { warmPaused.current = open; setSearchOpen(open); }, []);
  const loadAgent = useCallback((id: string, priority: RequestPriority = "high") => {
    const pending = requests.current.get(id);
    if (pending) return pending.promise;
    const updates = new Map<number, Entry>();
    const reactions = new Map<number, string>();
    const request = api.agent(id, undefined, priority).then((view) => {
      // An in-flight read must not erase entries already received live.
      const timeline = new Map(view.timeline.map(entry => [entry.id, entry]));
      for (const [id, entry] of updates) timeline.set(id, entry);
      for (const [id, reaction] of reactions) {
        const entry = timeline.get(id);
        if (entry) timeline.set(id, { ...entry, reaction });
      }
      const reconciled = { ...view, timeline: [...timeline.values()].sort((a, b) => a.id - b.id) };
      const save = () => setDetails((current) => {
        const previous = current[id];
        if (!previous) return { ...current, [id]: reconciled };
        const entries = new Map(previous.timeline.map(entry => [entry.id, entry]));
        for (const entry of reconciled.timeline) entries.set(entry.id, entry);
        return { ...current, [id]: { ...reconciled, hasEarlier: previous.hasEarlier, timeline: [...entries.values()].sort((a, b) => a.id - b.id) } };
      });
      if (priority === "low") startTransition(save); else save();
      return reconciled;
    }).finally(() => requests.current.delete(id));
    requests.current.set(id, { promise: request, updates, reactions });
    return request;
  }, [setDetails]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState<Agent | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const [savingTasks, setSavingTasks] = useState<Record<string, TaskItem>>({});
  const [creatingTasks, setCreatingTasks] = useState<Record<string, TaskItem & { existing: Set<string> }>>({});
  const [showArchived, setShowArchived] = useState(false);
  const [homeAdvice,setHomeAdvice]=useState<FocusData>({suggestions:[],feedback:{}});
  const [homeRevision,setHomeRevision]=useState(0);
  const [ready, setReady] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxWidth, setInboxWidth] = useState(340);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [jump, setJump] = useState(false);
  const [settings, setSettings] = useState(false);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  // Which board the main column shows when no agent is open. Null is the fleet.
  const [boardId, setBoardId] = useState<string | null>(null);
  // Which column the keyboard drives, and where it is in each.
  const [focus, setFocus] = useState<Column>("inbox");
  const [inboxAt, setInboxAt] = useState(0);
  const [fleetAt, setFleetAt] = useState(0);
  const [taskAt, setTaskAt] = useState(0);
  const [inboxDone, setInboxDone] = useState(false);
  const [taskQuery, setTaskQuery] = useState("");
  const [allTasks, setAllTasks] = useState(false);
  const decisionQueue = focusOpen && !allTasks;
  const [replyDecisionId,setReplyDecisionId]=useState<string|null>(null);
  const [decisionId,setDecisionId]=useState<string|null>(()=>{try{return new URL(window.location.href).searchParams.get("decision");}catch{return null;}});
  const chooseDecision=useCallback((id:string|null)=>{setDecisionId(id);if(id)setFocus("fleet");const url=new URL(window.location.href);if(id)url.searchParams.set("decision",id);else url.searchParams.delete("decision");window.history.replaceState(null,"",url);},[]);
  const scopedTasks = useSyncExternalStore(defaultWindowTasks.subscribe, defaultWindowTasks.get, defaultWindowTasks.fallback);
  const [windowTaskOverride, setWindowTaskOverride] = useState<boolean | null>(() => {
    try { const saved = sessionStorage.getItem("oxroute.windowTasks"); return saved === null ? null : saved === "true"; } catch { return null; }
  });
  const windowTasks = windowTaskOverride ?? scopedTasks === "on";
  const [windowDecisions,setWindowDecisions]=useState(()=>{try{return sessionStorage.getItem("oxroute.windowDecisions")==="true";}catch{return false;}});
  const windowScope=decisionQueue?windowDecisions:windowTasks;
  const setWindowTasks = useCallback((enabled: boolean) => {
    setWindowTaskOverride(enabled);
    sessionStorage.setItem("oxroute.windowTasks", String(enabled));
  }, []);
  const [shownTask, setShownTask] = useState<string | null>(null);
  const [taskFocusRequest, setTaskFocusRequest] = useState(0);
  /// Finished work you have said "not yet" to, answered in its composer.
  const [correcting, setCorrecting] = useState<TaskItem | null>(null);
  const [taskWidth, setTaskWidth] = useState(430);
  const vim = useSyncExternalStore(subscribeVimMode, getVimMode, defaultVimMode);
  const tone = useSyncExternalStore(theme.subscribe, theme.get, theme.fallback);
  const loud = useSyncExternalStore(verbose.subscribe, verbose.get, verbose.fallback);
  const drawn = useSyncExternalStore(graph.subscribe, graph.get, graph.fallback);
  const wrapped = useSyncExternalStore(wrap.subscribe, wrap.get, wrap.fallback);
  const nextLayout = useSyncExternalStore(nextActionLayout.subscribe, nextActionLayout.get, nextActionLayout.fallback);
  const scaled = useSyncExternalStore(scalePanes.subscribe, scalePanes.get, scalePanes.fallback);
  const scaleFloor = useSyncExternalStore(minimumPaneScale.subscribe, minimumPaneScale.get, minimumPaneScale.fallback);
  const terminalScale = useSyncExternalStore(terminalFontScale.subscribe, terminalFontScale.get, terminalFontScale.fallback);
  const inboxWidthRef = useRef(340);
  const lastInboxWidth = useRef(340);
  const paneLinks = useRef<Record<string, string>>({});
  // A signal the inbox cursor should land on as soon as the daemon reports it.
  const landOn = useRef<string | null>(null);
  const firstLoad = useRef(true);
  /// Digits typed before a motion, and a lone g waiting for its pair.
  const typed = useRef("");
  const pendingG = useRef(false);
  const readingMotion = useRef<{node: HTMLElement; top: number; actual: number} | null>(null);

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
      if (tasksAt >= 34) setTaskWidth(tasksAt);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  /// A column you left open is one you were using; it is still open when
  /// you come back.
  const showTasks = useCallback((open: boolean) => {
    setTasksOpen(open);
    window.localStorage.setItem("oxroute.tasks", String(open));
  }, []);

  const currentTasks = useRef(snapshot.tasks);
  currentTasks.current = snapshot.tasks;
  const taskTitleKey = JSON.stringify(snapshot.tasks.map(task => [task.id, task.text]));
  const taskLinks = useMemo(() => ({
    titles: new Map<string,string>(JSON.parse(taskTitleKey)),
    open: (id: string) => {
      showTasks(true);
      setWindowTasks(false);
      setTaskQuery("");
      setAllTasks(true); setShownTask(id);
      setTaskAt(taskRows(currentTasks.current).findIndex(row => row.task.id === id));
      setFocus("tasks");
      setTaskFocusRequest(request => request + 1);
    },
  }), [taskTitleKey, showTasks, setWindowTasks]);
  useLayoutEffect(() => {
    if (taskFocusRequest) document.querySelector<HTMLElement>('[data-task-panel] [data-task-row][aria-current="true"] [data-task-open]')?.focus({ preventScroll: true });
  }, [taskFocusRequest]);

  const setInboxVisible = useCallback((open: boolean) => {
    setInboxOpen(open);
    if (open) {
      setInboxWidth(lastInboxWidth.current);
      inboxWidthRef.current = lastInboxWidth.current;
    }
  }, []);

  /// How wide the task column is, within what is readable and what fits.
  const resizeTasks = (width: number) => {
    const next = Math.min(Math.max(width, 34), Math.max(window.innerWidth - 360, 34));
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

  const snapshotDirty = useRef(false);
  const reload = useCallback(() => {
    if (snapshotUpdates.current) { snapshotDirty.current = true; return; }
    setRevision((current) => current + 1);
  }, []);

  const entryFocused = useCallback((entry: number) => {
    setFocusEntry(current => current === entry ? null : current);
    const url = new URL(window.location.href);
    if (url.searchParams.get("entry") === String(entry)) {
      url.searchParams.delete("entry");
      window.history.replaceState(null, "", url);
    }
  }, []);

  const showAgent = useCallback((id: string | null, entry?: number) => {
    setFocusOpen(false);
    setOpen(id);
    // Opening an agent is walking into it: the keys act on it from here.
    if (id) setFocus("fleet");
    const saved = id ? readPanes(id) : null;
    customPanes.current = saved !== null;
    const group = saved ? paneIds(saved) : id ? linkedPanes(id, paneLinks.current) : [];
    setPanes(group);
    setFocusEntry(entry ?? null);
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    if (!id || url.searchParams.get("agent") !== id) url.searchParams.delete("review");
    if (id) url.searchParams.set("agent", id);
    else url.searchParams.delete("agent");
    if (id && entry !== undefined) url.searchParams.set("entry", String(entry));
    else url.searchParams.delete("entry");
    window.history.pushState(null, "", url);
  }, []);

  const openConversation=useCallback((id:string,entry?:number)=>{
    showAgent(id,entry);setDecisionId(null);
    const url=new URL(window.location.href);url.searchParams.delete('decision');
    if(id===snapshot.focusAgentId){setFocusOpen(true);url.searchParams.set('view','focus');}
    window.history.replaceState(null,'',url);
  },[showAgent,snapshot.focusAgentId]);

  const showFocus = () => {
    showAgent(null);
    clearRouting();
    setFocusOpen(true);
    setFocus("fleet");
    const url = new URL(window.location.href);
    url.searchParams.set("view", "focus");
    window.history.replaceState(null, "", url);
  };

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

  useEffect(captureClientFailures, []);

  const complain = useCallback(
    (error: unknown) => say(error instanceof Error ? error.message : String(error)),
    [say],
  );
  const setting = useCallback((work: () => Promise<unknown>) => {
    void work().then(reload).catch(complain);
  }, [reload, complain]);
  useEffect(() => { void terminalApi<TerminalInfo[]>("").then(setTerminals).catch(complain); }, [revision, complain]);

  useEffect(() => { void browserApi<BrowserInfo[]>("").then(setBrowsers).catch(complain); }, [revision, complain]);

  const revealedTools = useRef(new Set<string>());
  useEffect(() => {
    if (!open) return;
    const added = [...terminals, ...browsers].filter(pane => pane.agentId && panes.includes(pane.agentId) && !revealedTools.current.has(pane.id));
    if (!added.length) return;
    for (const pane of added) revealedTools.current.add(pane.id);
    customPanes.current = true;
    setPanes(current => [...current, ...added.map(pane => pane.id).filter(id => !current.includes(id))]);
  }, [open, terminals, browsers, panes]);

  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      setBoardId(url.searchParams.get("board"));
      const isFocus = url.searchParams.get("view") === "focus";
      setFocusOpen(isFocus);
      setDecisionId(url.searchParams.get("decision"));
      const agent = isFocus ? null : url.searchParams.get("agent");
      if (url.searchParams.has("transfer")) { setOpen(null); setPanes([]); return; }
      setOpen(agent);
      // Arriving at an agent is the same as walking into one: the keys act
      // on the conversation in front of you, not on the column beside it.
      if (agent || isFocus) setFocus("fleet");
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
      follow((event) => startTransition(() => {
        if (event.type === "progress") snapshotUpdates.current?.set(`progress:${event.agentId}`, event);
        if (event.type === "timeline" && MESSAGE_KINDS.has(event.entry.kind)) snapshotUpdates.current?.set(`message:${event.entry.agentId}`, event);
        switch (event.type) {
          case "progress":
            // High-frequency and one field wide, so it is patched in place
            // rather than costing a refetch several times a second.
            setSnapshot(current => streamedSnapshot(current, event));
            setDetails((current) => {
              const view = current[event.agentId];
              return view
                ? { ...current, [event.agentId]: { ...view, agent: { ...view.agent, activity: event.text } } }
                : current;
            });
            break;
          case "timeline":
            if (event.entry.kind === "review") preloadReview(reviewEndpoint(event.entry.agentId, event.entry.detail), true);
            requests.current.get(event.entry.agentId)?.updates.set(event.entry.id, event.entry);
            setSnapshot(current => streamedSnapshot(current, event));
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
          case "reaction":
            requests.current.get(event.agentId)?.reactions.set(event.entryId, event.reaction);
            setDetails(current => {
              const view = current[event.agentId];
              return view ? { ...current, [event.agentId]: { ...view,
                timeline: view.timeline.map(entry => entry.id === event.entryId ? { ...entry, reaction: event.reaction } : entry),
              } } : current;
            });
            break;
          case "notice":
            say(event.text);
            break;
          default:
            reload();
        }
      })),
    [reload, say, setDetails],
  );

  useEffect(() => {
    let scheduled = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible" || scheduled) return;
      scheduled = window.requestAnimationFrame(() => { scheduled = 0; reload(); });
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.cancelAnimationFrame(scheduled);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  // The fleet is passed in rather than read from state, so a snapshot that
  // has only just arrived can open the question it brought with it.
  const openRouting = useCallback(
    (item: InboxItem, agents: Agent[]) => {
      showAgent(null);
      setRouting(item.signal.id);
      setTicked(new Set(!item.recommendation && item.suggested ? [item.suggested] : []));
      setFocus("fleet");
      // Start on the agent this thread already belongs to, if it has one.
      const at = agents.findIndex((a) => a.id === item.suggested);
      setFleetAt(at >= 0 ? at : 0);
    },
    [showAgent],
  );

  useEffect(() => {
    let live = true;
    const updates = new Map<string, DaemonEvent>();
    snapshotUpdates.current = updates;
    api.snapshot().then(
      (next) => {
        if (!live) return;
        paneLinks.current = next.paneLinks ?? {};
        for (const [agent, ids] of Object.entries(next.reviews ?? {})) for (const id of ids) preloadReview(reviewEndpoint(agent, id));
        for (const agent of [...next.agents, ...next.archived]) creatingAgents.current.delete(agent.id);
        const reconciled = pendingSnapshot([...updates.values()].reduce(streamedSnapshot, next));
        setSnapshot(current => reconciled.taskNotesDeferred ? {...reconciled, taskNotes: current.taskNotes} : reconciled);
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
        // A routed decision hands keyboard focus to the next waiting item.
        const landed = inboxRows(next.inbox, false).findIndex(
          (row) => row.kind === "item" && row.item.signal.id === landOn.current,
        );
        if (landed < 0) return;
        landOn.current = null;
        setInboxAt(landed);
        const row = inboxRows(next.inbox, false)[landed];
        if (row.kind === "item" && row.item.state === "waiting") openRouting(row.item, next.agents);
        else setFocus("inbox");
      },
      (error: unknown) => live && complain(error),
    ).finally(() => {
      if (snapshotUpdates.current !== updates) return;
      snapshotUpdates.current = null;
      if (live && snapshotDirty.current) { snapshotDirty.current = false; reload(); }
    });
    return () => {
      live = false;
      if (snapshotUpdates.current === updates) snapshotUpdates.current = null;
    };
  }, [revision, complain, openRouting, setInboxVisible, pendingSnapshot, reload]);

  useEffect(() => {
    if (!tasksOpen || !snapshot.taskNotesDeferred) return;
    if (taskNotesRequest.current) { taskNotesDirty.current = true; return; }
    const request = api.taskNotes().then(taskNotes => {
      const taskNotesDeferred = taskNotesDirty.current;
      setSnapshot(current => ({...current, taskNotes, taskNotesDeferred}));
    }).catch(complain).finally(() => {
      taskNotesRequest.current = null;
      if (taskNotesDirty.current) {
        taskNotesDirty.current = false;
        setTaskNotesRevision(current => current + 1);
      }
    });
    taskNotesRequest.current = request;
  }, [tasksOpen, snapshot.taskNotesDeferred, revision, taskNotesRevision, complain]);

  const homeAdviceKey=JSON.stringify(snapshot.agents.map(agent=>[agent.id,agent.status,agent.updatedAt]));
  useEffect(()=>{
    if(open||focusOpen||!snapshot.nextActionSuggestions)return;
    const controller=new AbortController();
    api.focus(controller.signal).then(setHomeAdvice).catch(error=>{if(!controller.signal.aborted)complain(error);});
    return()=>controller.abort();
  },[open,focusOpen,homeAdviceKey,homeRevision,snapshot.nextActionSuggestions,complain]);

  useEffect(()=>{
    const id=snapshot.focusAgentId;
    if(!focusOpen||!id||open!==null)return;
    setFocusAgentId(id);setOpen(id);setPanes([id]);customPanes.current=false;setFocusEntry(null);
  },[focusOpen,snapshot.focusAgentId,open]);

  useEffect(()=>{
    if(!focusOpen)return;
    let live=true;setFocusError("");
    api.openFocus().then(agent=>{
      if(!live)return;
      setFocusAgentId(agent.id);
      setSnapshot(current=>({...current,focusAgentId:agent.id,agents:current.agents.some(item=>item.id===agent.id)?current.agents:[...current.agents,agent],archived:current.archived.filter(item=>item.id!==agent.id)}));
      setOpen(current=>current??agent.id);setPanes(current=>current.length?current:[agent.id]);
    }).catch(error=>{if(live)setFocusError(error instanceof Error?error.message:String(error));});
    return()=>{live=false;};
  },[focusOpen,focusRetry]);

  // Active cards should already have their conversation when opened.
  useEffect(() => {
    for (const agent of snapshot.agents) {
      if (warmed.current.has(agent.id)) continue;
      warmed.current.add(agent.id);
      warmQueue.current.push(agent.id);
    }
    const drain = () => {
      if (warmPaused.current) return;
      while (warming.current < 2 && warmQueue.current.length) {
        const id = warmQueue.current.shift()!;
        warming.current++;
        void loadAgent(id, "low").catch(() => warmed.current.delete(id)).finally(() => {
          warming.current--;
          drain();
        });
      }
    };
    drain();
  }, [snapshot.agents, loadAgent, searchOpen]);

  useEffect(() => {
    if (panes.length === 0) return;
    let live = true;
    // One pane at a time: a session that is a moment from existing -- just
    // spawned, or just forked -- must not blank the pane beside it. A pane
    // that could not be read keeps asking, because the sync that would have
    // asked again may never come: a dropped event stream leaves the pane
    // saying "Loading session…" for as long as you look at it.
    const fetchPanes = async () => {
      const chats = panes.filter(id => !id.startsWith("terminal_") && !id.startsWith("browser_"));
      for (let wait = 500; live; wait = Math.min(wait * 2, 8000)) {
        const answers = await Promise.allSettled(chats.map(id => loadAgent(id)));
        if (!live) return;
        const views = answers.flatMap((answer) =>
          answer.status === "fulfilled" ? [answer.value] : [],
        );
        if (views.length === chats.length) return;
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

  const correctTask = useCallback((task: TaskItem) => {
    if (!task.agentId) return say("Nobody has this task to correct");
    setCorrecting(task);
    if (!panes.includes(task.agentId)) showAgent(task.agentId);
  }, [panes, say, showAgent]);

  // Task edits are independent. Show each edit immediately and lock only
  // that row until it is saved; snapshots cannot erase an in-flight edit.
  const updateTask = useCallback(async (task: TaskItem, note?: string, approved?: boolean) => {
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
  }, [complain, reload]);

  const approveTaskTree = useCallback(async (task: TaskItem) => {
    const branch = taskSubtree(snapshot.tasks, task.id);
    if (branch.some(item => item.id in savingTasks)) return say("A subtask is still saving. Try again once it finishes.");
    setSavingTasks(current => ({ ...current, ...Object.fromEntries(branch.map(item => [item.id, { ...item, status: "complete", blockedByTaskId: "" }])) }));
    try {
      const saved = new Map((await api.approveTaskTree(task.id)).map(item => [item.id, item]));
      setSnapshot(current => ({ ...current, tasks: current.tasks.map(item => saved.get(item.id) ?? item) }));
      reload();
    } catch (error) { complain(error); }
    finally {
      setSavingTasks(current => {
        const next = { ...current };
        for (const item of branch) delete next[item.id];
        return next;
      });
    }
  }, [snapshot.tasks, savingTasks, say, complain, reload]);

  /// Filing a task from a composer. It goes to the bottom of a long list,
  /// so the list has to be open and looking at it, or nothing happened as
  /// far as anyone can see.
  const file = useCallback(async (text: string, images: File[], agentId = "", parentTaskId = "") => {
    const id = crypto.randomUUID();
    const at = Date.now() / 1000;
    const pending = {
      id, text, agentId, parentTaskId, status: "incomplete", blockedByTaskId: "",
      images: [], createdAt: at, updatedAt: at,
      existing: new Set(snapshot.tasks.map((task) => task.id)),
    } satisfies TaskItem & { existing: Set<string> };
    setCreatingTasks((current) => ({ ...current, [id]: pending }));
    showTasks(true);
    setAllTasks(true); setShownTask(id);
    try {
      const task = await api.createTaskWithImages(text, agentId, images, parentTaskId);
      setSnapshot((current) => ({
        ...current, tasks: [...current.tasks.filter((item) => item.id !== task.id), task],
      }));
      setAllTasks(true); setShownTask(task.id);
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
  }, [snapshot.tasks, showTasks, complain, reload]);

  const sendMessage = async (id: string, text: string, images: File[], queued: boolean, diffs: import("./lib/drafts").DiffQuote[] = [], requestId = "") => {
    if (sessionStorage.getItem("oxroute.blankAgent") === id) sessionStorage.removeItem("oxroute.blankAgent");
    try {
      await api.say(id, text, images, queued, diffs, requestId);
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
    if (!id || url.searchParams.get("agent") !== id) url.searchParams.delete("review");
    if (id) url.searchParams.set("agent", id);
    else url.searchParams.delete("agent");
    url.searchParams.delete("entry");
    window.history.pushState(null, "", url);
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

  const mergeInto = (source: string, target: string, archive: boolean) =>
    run(async () => {
      await api.merge(source, target, archive);
      customPanes.current = true;
      setPanes(current => {
        const next = archive ? current.filter(id => id !== source) : current;
        return next.includes(target) ? next : [...next, target];
      });
      setUrlAgent(target);
    });

  const choosePanes = (ids: string[]) => {
    const key = open && ids.includes(open) ? open : ids[0];
    if (key) {
      const tree = syncPanes(readPanes(open ?? key), ids);
      writePanes(key, tree);
    } else if (open) writePanes(open, null);
    if (open && !ids.includes(open)) {
      writePanes(open, null);
      setTabIds(current => [...new Set(current.flatMap(id => id === open ? key ? [key] : [] : [id]))]);
    }
    customPanes.current = true;
    setPanes(ids);
    if (key !== open) setUrlAgent(key ?? null);
  };

  const archiveAgent = (agent: Agent, archived: boolean, completeTasks = false) => {
    const previous = archivingAgents.current.get(agent.id);
    const request = (previous?.request.catch(() => {}) ?? Promise.resolve()).then(() => api.archive(agent.id, archived, completeTasks));
    const change = { agent, archived, request };
    archivingAgents.current.set(agent.id, change);
    const modal = archiving?.id === agent.id;
    const layout = open ? readPanes(open) : null;
    const blank = sessionStorage.getItem("oxroute.blankAgent") === agent.id;
    if (archived && blank) sessionStorage.removeItem("oxroute.blankAgent");
    setArchiving(null);
    setArchiveError("");
    setSnapshot(current => pendingSnapshot(current));
    if (archived) {
      if (panes.includes(agent.id)) choosePanes(panes.filter(id => id !== agent.id));
      setTabIds(current => current.filter(id => id !== agent.id));
    }
    const after = window.location.href;
    void request.then(next => {
      if (archivingAgents.current.get(agent.id) !== change) return;
      archivingAgents.current.delete(agent.id);
      setSnapshot(pendingSnapshot(next));
      reload();
    }).catch(error => {
      if (archivingAgents.current.get(agent.id) !== change) return;
      archivingAgents.current.delete(agent.id);
      setSnapshot(current => pendingSnapshot(archivedSnapshot(current, agent, !archived)));
      if (blank && !sessionStorage.getItem("oxroute.blankAgent")) sessionStorage.setItem("oxroute.blankAgent", agent.id);
      if (archived && window.location.href === after) {
        if (open) writePanes(open, layout);
        if (!focusOpen) showAgent(open);
        setPanes(panes);
        if (modal) { setArchiveError(error instanceof Error ? error.message : String(error)); setArchiving(agent); }
      }
      complain(error);
      reload();
    });
  };

  const requestArchive = (agent: Agent, archived: boolean) => {
    if (archived && snapshot.tasks.some(task => task.agentId === agent.id && task.status !== "complete")) {
      setArchiveError("");
      setArchiving(agent);
    } else archiveAgent(agent, archived);
  };

  const tabLayout = (id: string): PaneLayout => id === open ? syncPanes(readPanes(id), panes) ?? id : readPanes(id) ?? id;
  const removeTransferred = (offer: PaneOffer, closeWindow: boolean) => {
    if (!tabIds.includes(offer.root) && open !== offer.root) return;
    const initial = open === offer.root ? tabLayout(open) : readPanes(offer.root) ?? offer.origin;
    let remaining: PaneLayout | null = initial;
    for (const id of paneIds(offer.layout)) remaining = removePane(remaining, id);
    const root = remaining ? (paneIds(remaining).includes(offer.root) ? offer.root : paneIds(remaining)[0]) : null;
    if (root !== offer.root) writePanes(offer.root, null);
    if (remaining && root) writePanes(root, remaining);
    const tabs = [...new Set(tabIds.flatMap(id => id === offer.root ? root ? [root] : [] : [id]))];
    setTabIds(tabs);
    if (open === offer.root) { setPanes(paneIds(remaining)); setUrlAgent(root); setPaneRevision(value => value + 1); }
    if (closeWindow && !tabs.length && new URLSearchParams(location.search).has("detached")) window.close();
  };
  const transfer = usePaneTransfer({
    ready,
    known: [...snapshot.agents, ...snapshot.archived, ...terminals, ...browsers].map(session => session.id),
    error: say,
    depart: offer => removeTransferred(offer, true),
    receive: (offer, destination, local) => {
      const ids = paneIds(offer.layout);
      if (destination.kind === "pane") {
        if (!open || !panes.includes(destination.id)) return false;
        if (local && offer.root === open && ids.length === panes.length && ids.every(id => panes.includes(id))) return () => {};
        const tree = dockPanes(tabLayout(open), offer.layout, destination.id, destination.edge);
        return () => {
          if (local && offer.root !== open) removeTransferred(offer, false);
          writePanes(open, tree); customPanes.current = true;
          setPanes(paneIds(tree)); setPaneRevision(value => value + 1);
        };
      }
      const root = ids.includes(offer.root) ? offer.root : ids[0];
      const existing = tabIds.includes(root) && (!local || offer.root !== root) ? readPanes(root) : null;
      const tree = existing ? syncPanes(existing, [...new Set([...paneIds(existing), ...ids])])! : offer.layout;
      return () => {
        if (local) removeTransferred(offer, false);
        writePanes(root, tree); customPanes.current = true;
        setTabIds(current => [...new Set([...current, root])]);
        setPanes(paneIds(tree)); setUrlAgent(root); setPaneRevision(value => value + 1);
      };
    },
  });

  // Both columns as they are drawn, so the keyboard counts the rows on
  // screen rather than the data behind them.
  const rows = inboxRows(snapshot.inbox, inboxDone);

  const taskItems = useMemo(() => {
    const pending = Object.values(creatingTasks);
    for (const task of snapshot.tasks) {
      const at = pending.findIndex(item => !item.existing.has(task.id) &&
        item.text === task.text && item.agentId === task.agentId && item.parentTaskId === task.parentTaskId);
      if (at >= 0) pending.splice(at, 1);
    }
    return [...snapshot.tasks.map(task => savingTasks[task.id] ?? task), ...pending];
  }, [snapshot.tasks, savingTasks, creatingTasks]);
  // Task controls use identity and names, never high-frequency progress fields.
  const priorityData = JSON.stringify(Object.fromEntries(Object.entries(snapshot.taskPriorities ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  const taskPriorities = useMemo(() => JSON.parse(priorityData) as Snapshot["taskPriorities"], [priorityData]);
  const reviewPriorityData=JSON.stringify(snapshot.reviewPriorities??{});
  const reviewPriorities=useMemo(()=>JSON.parse(reviewPriorityData) as Snapshot["reviewPriorities"],[reviewPriorityData]);
  const taskAgents = useTaskAgents(snapshot.agents);
  const namedTasks = useTaskAgents([...snapshot.agents, ...snapshot.archived]);
  const taskNames = useMemo(() => new Map(namedTasks.map(agent => [agent.id, agent.name])), [namedTasks]);
  const conversationReferences = useMemo(() => focusOpen ? JSON.stringify(namedTasks.map(agent => agent.id).sort()) : null, [focusOpen, namedTasks]);
  const taskSearch = taskQuery.trim().toLowerCase();
  const scopeIds = windowScope ? [...new Set([...tabIds.flatMap(id => {
    if (id === open) return panes;
    const saved = readPanes(id);
    return saved ? paneIds(saved) : linkedPanes(id, snapshot.paneLinks);
  }), ...panes].flatMap(id => (id.startsWith("terminal_") || id.startsWith("browser_")) ? [...terminals, ...browsers].flatMap(pane => pane.id === id && pane.agentId ? [pane.agentId] : []) : [id]))].filter(id => taskNames.has(id)).sort() : undefined;
  const taskScopeKey = JSON.stringify(scopeIds ?? null);
  const taskScope = useMemo(() => JSON.parse(taskScopeKey) as string[] | null, [taskScopeKey]) ?? undefined;
  useEffect(() => { if (windowScope) setTaskAt(0); }, [taskScopeKey, windowScope]);
  const tasks = useMemo(() => {
    const scoped = taskScope ? taskItems.filter(task => taskScope.includes(task.agentId)) : taskItems;
    const matches = scoped.filter(task => task.status !== "complete" && (!taskSearch || `${task.text} ${taskNames.get(task.agentId) ?? ""}`.toLowerCase().includes(taskSearch)));
    return taskRows(taskAncestors(scoped, matches));
  }, [taskItems, taskScope, taskSearch, taskNames, decisionQueue, taskPriorities]);
  const decisionItems=useMemo(()=>focusDecisions(taskItems,taskPriorities,reviewPriorities).filter(item=>(!taskScope||taskScope.includes(item.agentId))&&(!taskSearch||`${item.title} ${item.state.recommendation?.humanReason} ${item.state.recommendation?.unblocks} ${taskNames.get(item.agentId)??""}`.toLowerCase().includes(taskSearch))),[taskItems,taskPriorities,reviewPriorities,taskScope,taskSearch,taskNames]);
  const decisionReferences=useMemo(()=>new Map(focusDecisions(taskItems,taskPriorities,reviewPriorities).flatMap(item=>item.state.decisionRevision?[[item.id,{id:item.id,revision:item.state.decisionRevision}] as const]:[])),[taskItems,taskPriorities,reviewPriorities]);
  const reviewOwnerKey = JSON.stringify(Object.entries(snapshot.reviews ?? {}).flatMap(([id, reviews]) => reviews.map(review => [review, {id, name: taskNames.get(id) ?? "Conversation"}])));
  const embeddedReviews = useMemo(() => focusOpen && focusAgentId ? {
    owners: new Map<string, {id:string;name:string}>(JSON.parse(reviewOwnerKey)),
    quote: (quote: DiffQuote,decision=decisionId) => {if(decision)setReplyDecisionId(decision);const item=decisionItems.find(item=>item.id===decision);if(item?.state.decisionRevision&&!quote.decision)quote={...quote,decision:{id:item.id,revision:item.state.decisionRevision}};receiveDraft(focusAgentId, {text:"", files:[], diffs:[quote]});chooseDecision(null);if(window.innerWidth<640)setTasksOpen(false);},
  } : null, [focusOpen, focusAgentId, reviewOwnerKey,decisionId,decisionItems]);
  const replyToDecision=useCallback((item:typeof decisionItems[number],text?:string)=>{embeddedReviews?.quote({...titleQuote(text??`${item.title} · ${item.state.recommendation?.humanReason}`,{agentId:item.agentId,reviewId:item.reviewId,taskId:item.taskId,evidenceEntryIds:item.state.recommendation?.evidenceEntryIds}),decision:item.state.decisionRevision?{id:item.id,revision:item.state.decisionRevision}:undefined},item.id);},[embeddedReviews]);
  const openDecisionSource=useCallback((item:typeof decisionItems[number])=>void run(async()=>{const entries=await api.citedEntries(item.state.recommendation?.evidenceEntryIds??[]);const source=entries.findLast(entry=>entry.agentId===item.agentId);if(source){chooseDecision(null);openConversation(source.agentId,source.id);if(window.innerWidth<640)setTasksOpen(false);}else chooseDecision(item.id);}),[run,chooseDecision,openConversation]);
  useEffect(()=>{if(decisionId&&decisionItems.length&&!decisionItems.some(item=>item.id===decisionId))chooseDecision(decisionItems[0].id);},[decisionId,decisionItems,chooseDecision]);
  const scopeTasks = useCallback(() => { if(decisionQueue){setWindowDecisions(!windowDecisions);sessionStorage.setItem("oxroute.windowDecisions",String(!windowDecisions));}else setWindowTasks(!windowTasks);setTaskAt(0); }, [decisionQueue,windowDecisions,windowTasks,setWindowTasks]);
  const searchTasks = useCallback((query: string) => { setTaskQuery(query); setTaskAt(0); setFocus("tasks"); }, []);
  const taskBusy = useCallback((id: string) => busy || id in savingTasks || id in creatingTasks, [busy, savingTasks, creatingTasks]);
  const taskActions = useMemo(() => ({
    tasks: taskItems, embedded: focusOpen, busy: taskBusy,
    approve: (task: TaskItem) => void updateTask({ ...task, status: "complete" }, "approved", true),
    approveAll: approveTaskTree, correct: correctTask,
  }), [taskItems, focusOpen, taskBusy, updateTask, approveTaskTree, correctTask]);
  const createSubtask = useCallback((text: string, parent: TaskItem) => {
    setTaskQuery(""); return file(text, [], parent.agentId, parent.id);
  }, [file]);
  const openTaskAgent = useCallback((id: string) => {
    setRouting(null); setTicked(new Set()); showAgent(id);
  }, [showAgent]);
  const handOffTask = useCallback((task: TaskItem, fork: boolean) =>
    void run(() => api.handOffTask(task.id, fork, snapshot.defaultModel)), [run, snapshot.defaultModel]);
  const deleteTask = useCallback((id: string) => void run(() => api.deleteTask(id)), [run]);
  const approveFocusTask = useCallback((task: TaskItem) => void updateTask({...task, status:"complete", blockedByTaskId:""}, "approved", true), [updateTask]);

  const selected = snapshot.inbox.find((item) => item.signal.id === routing) ?? null;
  useEffect(() => {
    if (!routing) return;
    let current = true;
    void api.routingRecommendation(routing).then(recommendation => {
      if (current && recommendation) setSnapshot(snapshot => ({...snapshot, inbox: snapshot.inbox.map(item => item.signal.id === routing ? {...item, recommendation} : item)}));
    }).catch(complain);
    return () => {current = false;};
  }, [routing, complain]);
  const activeBoard = snapshot.boards.find((board) => board.id === boardId) ?? (boardId ? snapshot.boards[0] : null);
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
      } else if (["slack-inbox","outlook-inbox"].includes(item.signal.source)) openRouting(item, snapshot.agents);
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
      if ((event.target as HTMLElement)?.closest?.("[data-terminal-pane]")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const control = (event.target as Element)?.closest?.("button,a[href]");
      if ((event.key === "Enter" && control) || (event.key === " " && control?.tagName === "BUTTON")) return;
      if (isTyping(event.target)) {
        // Escape gets you out of the compose box and back to the keys.
        if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement)) (event.target as HTMLElement).blur();
        return;
      }

      if (focusOpen && focus === "fleet" && !["h", "l", "Escape", "i", "/", "m", "v", "?", "f", "n"].includes(event.key)) return;

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
        focus === "inbox" ? rows.length : focus === "fleet" ? fleet.length : decisionQueue ? decisionItems.length : tasks.length;
      const move = (delta: number) => {
        // In an open agent the middle column is a conversation, not a list,
        // so moving in it means reading it.
        if (focus === "fleet" && reading) {
          const node = document.querySelector<HTMLElement>('[data-pane-active="true"] [data-transcript]');
          if (node) {
            const previous = readingMotion.current;
            // Keep the fractional target: scaled scroll offsets round differently across engines.
            const top = previous?.node === node && previous.actual === node.scrollTop ? previous.top : node.scrollTop;
            const target = Math.max(0, Math.min(top + delta * 90, node.scrollHeight - node.clientHeight));
            node.scrollTop = target;
            readingMotion.current = {node, top: target, actual: node.scrollTop};
          }
          return;
        }
        const setAt =
          focus === "inbox" ? setInboxAt : focus === "fleet" ? setFleetAt : setTaskAt;
        setAt((current) => Math.min(Math.max(current + delta, 0), Math.max(here - 1, 0)));
      };
      /// The top or the bottom of whatever is in front of you.
      const toEnd = (way: number) => {
        readingMotion.current = null;
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
          const row = decisionQueue ? tasks.find(row=>row.task.id===decisionItems[taskAt]?.taskId&&!decisionItems[taskAt]?.reviewId) : tasks[taskAt];
          if (!row) return;
          const up = event.key === "K";
          // The task it lands after: the one two places up when moving up,
          // and the one immediately below when moving down.
          const live = tasks.map((entry) => entry.task);
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
          if(focusOpen&&decisionId){chooseDecision(null);return;}
          if (open || focusOpen) return showAgent(null);
          clearRouting();
          return setFocus("inbox");
        case "Enter": {
          stop();
          if (focus === "tasks") {
            // Enter opens whatever the cursor is on, and with an empty
            // column the only thing to open is the box that fills it.
            document.querySelectorAll<HTMLElement>("[data-task-open]")[taskAt]?.click();
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
    <ConversationNavigation.Provider value={openConversation}><ArtifactRoot.Provider value={snapshot.artifactRoot}>
    <TaskLinks.Provider value={taskLinks}>
    <TaskActions.Provider value={taskActions}>
    <ConversationCards.Provider value={focusOpen?{state:{...snapshot,tasks:taskItems},batchEntry:focusAgentId?details[focusAgentId]?.timeline.findLast(entry=>entry.kind==="said"&&entry.text.includes("#agent/"))?.id:undefined,onTask:taskLinks.open,onSent:reload}:null}>
    <ConversationReferences.Provider value={conversationReferences}><CoordinationTitles.Provider value={taskNames}>
    <DecisionReferences.Provider value={decisionReferences}><EmbeddedReviews.Provider value={embeddedReviews}>
    <main className="flex h-full flex-col">
      <FrontendVersion />
      {archiving && <ArchiveAgent agent={archiving} tasks={snapshot.tasks.filter(task => task.agentId === archiving.id)} error={archiveError} onCancel={() => setArchiving(null)} onArchive={completeTasks => archiveAgent(archiving, true, completeTasks)} />}
      {help && <Help onClose={() => setHelp(false)} />}
      {settings && (
        <Settings
          recommendationLearning={snapshot.recommendationLearning}
          onRecommendationLearning={enabled => setting(() => api.setRecommendationLearning(enabled))}
          nextActionLayout={nextLayout}
          onNextActionLayout={nextActionLayout.set}
          automaticTags={snapshot.automaticTags}
          onAutomaticTags={enabled => setting(() => api.setAutomaticTags(enabled))}
          automaticTitles={snapshot.automaticTitles}
          onAutomaticTitles={enabled => setting(() => api.setAutomaticTitles(enabled))}
          theme={tone}
          onTheme={theme.set}
          verbose={loud}
          onVerbose={verbose.set}
          defaultWindowTasks={scopedTasks}
          onDefaultWindowTasks={defaultWindowTasks.set}
          graph={drawn}
          onGraph={graph.set}
          wrap={wrapped}
          onWrap={wrap.set}
          scalePanes={scaled}
          onScalePanes={scalePanes.set}
          terminalFontScale={terminalScale}
          onTerminalFontScale={terminalFontScale.set}
          minimumPaneScale={scaleFloor}
          onMinimumPaneScale={minimumPaneScale.set}
          vim={vim}
          onVim={setVimMode}
          onClose={() => setSettings(false)}
        />
      )}
      {jump && <Jump onDone={() => setJump(false)} />}
      <Chrome
        scaleKey={[open, paneRevision, ...panes.map(id => `${id}:${!!details[id]}`)].join(",")}
        tabs={<SessionTabs sessions={[...snapshot.agents, ...snapshot.archived, ...terminals, ...browsers]} ids={tabIds} active={open} focusOpen={focusOpen} onFocus={showFocus} onSelect={showAgent}
          onReorder={(id, target, after) => setTabIds(current => {
            if (id === target || !current.includes(id)) return current;
            const next = current.filter(tab => tab !== id);
            const at = target === null ? next.length : next.indexOf(target);
            if (at < 0) return current;
            next.splice(at + (target !== null && after ? 1 : 0), 0, id);
            return next;
          })}
          onClose={id => {
            const known = new Set([...snapshot.agents, ...snapshot.archived, ...terminals, ...browsers].map(session => session.id));
            const visible = tabIds.filter(tab => known.has(tab));
            const index = visible.indexOf(id); setTabIds(current => current.filter(tab => tab !== id));
            if (open === id) showAgent(visible[index + 1] ?? visible[index - 1] ?? null);
          }} onDragStart={(event, id) => transfer.start(event, id, tabLayout(id))} onDragEnd={transfer.end}
          onDrop={event => transfer.drop(event, { kind: "tab" })} onDetach={id => transfer.detach(id, tabLayout(id))} />}
        panes={<AgentPicker agents={[...snapshot.agents, ...snapshot.archived, ...terminals, ...browsers]} selected={panes} onSelect={choosePanes} onBrowser={snapshot.agents.some(agent => agent.id === open) ? () => {
          void browserApi<BrowserInfo>("", { agentId: open }).then(browser => {
            setBrowsers(current => [...current.filter(item => item.id !== browser.id), browser]);
            choosePanes([...new Set([...panes, browser.id])]);
          }).catch(complain);
        } : undefined} onFollowTerminal={snapshot.agents.some(agent => agent.id === open) ? () => {
          void terminalApi<{ terminal: TerminalInfo }>("", { agentId: open, follow: true }).then(({ terminal }) => {
            setTerminals(current => [...current, terminal]);
            choosePanes([...panes, terminal.id]);
          }).catch(complain);
        } : undefined} onTerminal={() => {
          void terminalApi<{ terminal: TerminalInfo; controller: string }>("", {}).then(({ terminal, controller }) => {
            localStorage.setItem(`oxroute.terminal.${terminal.id}`, controller);
            setTerminals(current => [...current, terminal]);
            choosePanes([...panes, terminal.id]);
          }).catch(complain);
        }} />}
        snapshot={snapshot}
        notice={notice}
        onMode={(mode: Mode) => {if (mode !== snapshot.mode) setting(() => api.setMode(mode));}}
        onNextActionMode={(mode: Mode) => setting(() => api.setNextActionMode(mode))}
        onNextActionSuggestions={(enabled: boolean) => setting(() => api.setNextActionSuggestions(enabled))}
        inboxOpen={inboxOpen}
        onInbox={() => setInboxVisible(!inboxOpen)}
        tasksOpen={tasksOpen}
        onTasks={() => showTasks(!tasksOpen)}
        onSettings={() => setSettings(true)}
        activeBoard={boardId}
        onBoard={showBoard}
        onNewAgent={() => {
          const id = sessionStorage.getItem("oxroute.blankAgent");
          const existing = id && (creatingAgents.current.get(id) ?? snapshot.agents.find(agent => agent.id === id));
          if (existing && !existing.sessionId && !snapshot.messages[existing.id] && !details[existing.id]?.timeline.some(entry => MESSAGE_KINDS.has(entry.kind))) {
            clearRouting();
            showAgent(existing.id);
            return;
          }
          const at = Date.now() / 1000;
          const model = snapshot.defaultModel;
          const agent: Agent = {
            id: `agent_${crypto.randomUUID().replaceAll("-", "")}`, name: "New agent",
            backend: snapshot.models.find(item => item.id === model)?.backend ?? "codex",
            model, sessionId: "", cwd: "", status: "complete", activity: "", permalink: "",
            lastActivity: at, updatedAt: at, stallReason: null, stallAlerted: false, pinned: false,
          };
          creatingAgents.current.set(agent.id, agent);
          sessionStorage.setItem("oxroute.blankAgent", agent.id);
          setSnapshot(current => ({ ...current, agents: [...current.agents, agent] }));
          setDetails(current => ({ ...current, [agent.id]: { agent, timeline: [], delivery: "start" } }));
          clearRouting();
          showAgent(agent.id);
          void api.createAgent(agent.id).then(reload).catch(complain);
        }}
        onSearchVisibility={searchVisibility}
        onSearchOpen={showAgent}
        onSearchContinue={(agent) => {
          reload();
          showAgent(agent);
        }}
      />

      <div className="relative flex min-h-0 flex-1">
        {inboxOpen ? (
          <>
            <div className="shrink-0 overflow-hidden" style={{ width: `min(${inboxWidth}px, 100vw)` }}>
              <Inbox
                connectors={snapshot.inboxConnectors}
                items={snapshot.inbox}
                rows={rows}
                onShowDone={() => setInboxDone((shown) => !shown)}
                agents={snapshot.agents}
                selected={routing}
                onSelect={pick}
                busy={busy}
                cursor={inboxAt}
                active={focus === "inbox"}
                waitingCount={snapshot.inboxWaiting}
                onClear={() => void run(() => api.clearInbox(snapshot.inboxClearThrough ?? 0), clearRouting)}
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

        {focusOpen&&(!focusAgentId||!open) ? <section aria-label="Focus" className="min-w-0 flex-1 px-[var(--pane-x)] py-6 text-[13px] text-faint">
          {focusError?<><p role="alert">{focusError}</p><button type="button" aria-label="Retry Focus" title="Retry Focus" className="mt-3 cursor-pointer" onClick={()=>setFocusRetry(value=>value+1)}><Icon name="refresh"/></button></>:<p role="status">Opening Focus…</p>}
        </section> : focusOpen&&decisionId&&decisionItems.length ? <FocusDecisionDeck items={decisionItems} selected={decisionId} onSelect={chooseDecision} onReply={replyToDecision}/> : open ? (
          <PaneWorkspace key={open} workspace={open} ids={panes} revision={paneRevision}
            onDragStart={(event, id) => transfer.start(event, open, id, tabLayout(open))} onDragEnd={transfer.end}
            onDock={(event, id, edge) => transfer.drop(event, { kind: "pane", id, edge })} onDetach={id => transfer.detach(open, id, tabLayout(open))}
            mergeTargets={[...snapshot.agents, ...snapshot.archived]} onMerge={(source, target, archive) => void mergeInto(source, target, archive)} keyboard={vim && focus === "fleet" && !selected} onActivate={() => setFocus("fleet")} onCustomize={() => { customPanes.current = true; }} onClose={id => focusOpen?showAgent(null):choosePanes(panes.filter(pane => pane !== id))}>
            {(id, index, paneHandle) => {
              if (id.startsWith("browser_")) return <BrowserPane id={id} handle={paneHandle} onEnd={() => { setBrowsers(current => current.filter(browser => browser.id !== id)); choosePanes(panes.filter(pane => pane !== id)); }} />;
              if (id.startsWith("terminal_")) return <TerminalPane id={id} handle={paneHandle} agents={[...snapshot.agents, ...snapshot.archived]} onEnd={() => { setTerminals(current => current.filter(terminal => terminal.id !== id)); choosePanes(panes.filter(pane => pane !== id)); }} />;
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
                      quietCoordination={id === snapshot.focusAgentId}
                      paneHandle={paneHandle}
                      view={view}
                      globalAutorun={snapshot.nextActionMode === "auto"}
                      onAutorun={enabled => api.setAutorun(id, enabled).then(result => {
                        setDetails(current => current[id] ? {...current, [id]: {...current[id], autorun: result.autorun}} : current);
                      }).catch(complain)}
                      onEarlier={async () => {
                        const page = await api.agent(id, view.timeline[0]?.id);
                        setDetails(current => {
                          const latest = current[id] ?? view;
                          const entries = new Map(page.timeline.map(entry => [entry.id, entry]));
                          for (const entry of latest.timeline) entries.set(entry.id, entry);
                          return { ...current, [id]: { ...latest, hasEarlier: page.hasEarlier, timeline: [...entries.values()].sort((a, b) => a.id - b.id) } };
                        });
                      }}
                      quoteThreads={(snapshot.quoteThreads ?? []).filter(thread => thread.parentId === id)}
                      onThreadsChanged={reload}
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
                      onSay={(text, images, queued, diffs, requestId) => sendMessage(id, text, images, queued, diffs, requestId)}
                      onTask={(text, images) => file(text, images, id)}
                      correcting={correcting?.agentId === id ? correcting : null}
                      onStopCorrecting={() => setCorrecting(null)}
                      onCorrect={async (text, images, queued, taskId = correcting?.id) => {
                        setCorrecting(null);
                        if (!taskId) return false;
                        setBusy(true);
                        try {
                          await api.correctTask(taskId, text, images, queued);
                          reload();
                          return true;
                        } catch (error) { complain(error); return false; }
                        finally { setBusy(false); }
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
                      onReact={(entry, reaction) => void api.react(entry, reaction).catch(complain)}
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
                      onArchive={archived => requestArchive(view.agent, archived)}
                      focusEntry={panes.length === 1 ? focusEntry : null}
                      onEntryFocused={entryFocused}
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
            {boardId && !selected ? (
              <>
                <div className="flex items-center gap-3 border-b border-rule px-[var(--pane-x)] py-2">
                  <select aria-label="Choose board" value={activeBoard?.id ?? ""} onChange={(event) => showBoard(event.target.value)} className="bg-card text-[13px] text-ink">
                    {!activeBoard && <option value="">Choose board</option>}
                    {snapshot.boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
                  </select>
                  <button type="button" disabled={busy} className="cursor-pointer text-[13px] text-mid hover:text-ink" onClick={() => void run(async () => {
                    const board = await api.createBoard({});
                    showBoard(board.id);
                  })}>Create board</button>
                </div>
                {activeBoard ? <BoardView
                key={activeBoard.id}
                board={activeBoard}
                snapshot={snapshot}
                revision={revision}
                busy={busy}
                run={run}
                say={say}
                onDeleted={() => showBoard("boards")}
                onOpenAgent={(id) => {
                  clearRouting();
                  showAgent(id);
                }}
              /> : <p className="px-[var(--pane-x)] py-6 text-[13px] text-faint">Create a board to arrange sessions by tags.</p>}
              </>
            ) : (
              <Fleet key={showArchived?"archived":"home"}
                renderActions={agent=><HomeActions agent={agent} nextActions={snapshot.nextActionSuggestions?homeAdvice.suggestions.find(item=>item.agent.id===agent.id&&item.agent.updatedAt===agent.updatedAt)?.nextActions:undefined} tasks={taskItems.filter(task=>task.agentId===agent.id)} busy={id=>id in savingTasks} onSent={()=>{setHomeRevision(value=>value+1);reload();}} onTask={taskLinks.open} onApprove={approveFocusTask} onCorrect={correctTask}/>}
                onArchive={requestArchive}
                agents={(showArchived ? snapshot.archived : snapshot.agents).filter(agent=>agent.id!==snapshot.focusAgentId)}
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
              className="relative z-30 w-0 shrink-0 cursor-col-resize outline-none"
            >
              <span className="absolute inset-y-0 -left-[4px] w-[8px]" />
            </div>
            <div data-task-pane className="flex min-h-0 shrink-0 flex-col overflow-hidden" style={{ width: taskWidth, maxWidth: "100vw" }}>
          <TaskPanel
            tasks={taskItems}
            rows={tasks} priorities={taskPriorities}
            decisions={decisionQueue} decisionItems={decisionItems} selectedDecision={decisionId??replyDecisionId} onDecision={chooseDecision} onReply={replyToDecision}
            onSource={openDecisionSource}
            reviewingDecisions={[...Object.values(taskPriorities ?? {}),...Object.values(reviewPriorities??{})].some(state => state.stale || (state.needsReview && state.recommendation?.nextActor === "human"))}
            onDecisions={focusOpen ? () => { setAllTasks(value => !value); setTaskAt(0); } : undefined}
            query={taskQuery}
            scope={taskScope}
            onScope={scopeTasks}
            onSearch={searchTasks}
            notes={snapshot.taskNotes}
            cursor={taskAt}
            active={focus === "tasks"}
            shown={shownTask}
            graph={drawn === "on"}
            agents={taskAgents}
            named={namedTasks}
            busy={taskBusy}
            onCreate={createSubtask}
            onUpdate={updateTask}
            onApproveAll={approveTaskTree}
            onOpenAgent={openTaskAgent}
            onCorrect={correctTask}
            onHandOff={handOffTask}
            onDelete={deleteTask}
          />
            </div>
          </>
        )}
      </div>
    </main>
    </EmbeddedReviews.Provider></DecisionReferences.Provider>
    </CoordinationTitles.Provider></ConversationReferences.Provider>
    </ConversationCards.Provider>
    </TaskActions.Provider>
    </TaskLinks.Provider>
    </ArtifactRoot.Provider></ConversationNavigation.Provider>
  );
}
