"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {useRecommendationExposure} from "../lib/recommendation-exposure";
import { api } from "../lib/api";
import { clock, since } from "../lib/format";
import { isTyping } from "../lib/keys";
import type { AgentView, BackendInfo, DiagramEdit, Entry, EntryKind, ModelInfo, TaskItem, QuoteAnchor, QuoteThread } from "../lib/types";
import { DiagramComposer } from "./composer/DiagramComposer";
import { Attachments } from "./composer/Attachments";
import { FileReviewProvider, ReviewFileButton, ReviewImage } from "./FileReview";
import { GitReview } from "./GitReview";
import { preloadReview, reviewEndpoint } from "../lib/reviews";
import { Code } from "./Code";
import { Copyable } from "./Copyable";
import { Sketch, type SketchHandle } from "./composer/Sketch";
import { acceptsFileDrop, useUploads } from "../lib/uploads";
import { DRAFT_CHANGED, draftFor, keepDraft, diffsFor, keepDiffs, type DiffQuote } from "../lib/drafts";
import { usePinnedMessages } from "../lib/pinned-messages";
import DiffAttachment from "./DiffAttachment";
import { TagEditor, tagChange } from "./Tags";
import { Icon, type IconName } from "./Icon";
import { Markdown, ReviewLinks, QuoteLinks } from "./Markdown";
import { QuoteDiscussion } from "./QuoteDiscussion";
import { SplitAction } from "./SplitAction";

/// What the person said needs no label: it is the one that sits on the
/// right, in its own tint.
const MINE: EntryKind[] = ["you", "received"];

const TAG: Partial<Record<EntryKind, { label: string; tone: string }>> = {
  asked: { label: "asked", tone: "text-hold border-hold" },
  forked: { label: "forked", tone: "text-merge border-merge" },
  forkedFrom: { label: "parent", tone: "text-merge border-merge" },
  merged: { label: "merged", tone: "text-merge border-merge" },
  mergedInto: { label: "merged", tone: "text-merge border-merge" },
  notice: { label: "note", tone: "text-faint" },
};

type TimelineItem = { entry: Entry } | { tools: Entry[] };
/** Three ways to tell an agent something: say it, redraw the architecture, or mark up a picture. */
type Mode = "type" | "diagram" | "draw";

const MODES: { mode: Mode; label: string; icon: IconName }[] = [
  { mode: "type", label: "Type", icon: "text" },
  { mode: "diagram", label: "Diagram", icon: "diagram" },
  { mode: "draw", label: "Draw", icon: "pen" },
];

const PLACEHOLDER: Record<Mode, string> = {
  type: "Message",
  diagram: "Anything the agent should know about this change",
  draw: "What should change here?",
};

/** `…\n\nAttached: a.png, b.png` is how the daemon records sent images. */
function splitAttached(text: string): { body: string; names: string[] } {
  const match = text.match(/(?:^|\n\n)Attached: (.+)$/);
  if (!match || match.index === undefined) return { body: text, names: [] };
  return {
    body: text.slice(0, match.index),
    names: match[1].split(", ").map((name) => name.trim()).filter(Boolean),
  };
}
/// Quote the selection or the clicked message, and react to that message.
type LineMenu = { text: string; entry: number | null; reaction: string; slackUrl: string; x: number; y: number; anchor: QuoteAnchor | null };
type SelectedQuote = Pick<LineMenu, "text" | "anchor">;

function quoteAnchor(row: Element | null, entryId: number | null): QuoteAnchor | null {
  const content = row?.querySelector(".message-markdown");
  const selection = window.getSelection();
  if (!content || entryId === null || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(content); prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const end = start + range.toString().length;
  const text = content.textContent?.slice(start, end) ?? "";
  return text.trim() ? { entryId, start, end, text } : null;
}

function selectedText(node: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!node || !selection?.rangeCount || selection.isCollapsed) return "";
  const range = selection.getRangeAt(0).cloneRange();
  if (!range.intersectsNode(node)) return "";
  const bounds = document.createRange();
  bounds.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
    range.setStart(bounds.startContainer, bounds.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
    range.setEnd(bounds.endContainer, bounds.endOffset);
  }
  return range.toString().trim();
}

const REACTIONS: { key: string; icon: IconName; label: string }[] = [
  { key: "up", icon: "thumbUp", label: "Thumbs up" },
  { key: "down", icon: "thumbDown", label: "Thumbs down" },
];

function compactTimeline(entries: Entry[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind !== "worked") {
      items.push({ entry });
      continue;
    }
    const last = items.at(-1);
    if (last && "tools" in last) last.tools.push(entry);
    else items.push({ tools: [entry] });
  }
  return items;
}

function minute(at: number) {
  return clock(at).slice(0, 5);
}

/**
 * Inside one agent: what came in and what it did, on one timeline, with a
 * box at the bottom that writes straight into it.
 *
 * The compose box is the thing that makes a surface co-equal. Typing here
 * reaches the agent exactly as a Slack reply would, and the answer comes back
 * in both places.
 */
export function AgentPanel({
  view,
  onEarlier,
  can,
  onBack,
  onSay,
  onTask,
  correcting,
  onCorrect,
  onStopCorrecting,
  onInterrupt,
  onFork,
  onForkBeside,
  onMerge,
  onOpenAgent,
  onRename,
  archived,
  onArchive,
  busy,
  focusEntry,
  onEntryFocused,
  verbose,
  onSendDiagram,
  onCreateDiagram,
  say,
  tags,
  knownTags,
  onTag,
  onReact,
  models,
  onModel,
  globalAutorun,
  onAutorun,
  initialPreview,
  paneHandle,
  quoteThreads,
  onThreadsChanged,
}: {
  view: AgentView;
  onEarlier: () => Promise<void>;
  /** The card's latest message while the full history arrives. */
  initialPreview?: string;
  paneHandle?: ReactNode;
  quoteThreads: QuoteThread[];
  onThreadsChanged: () => void;
  /// What this agent's harness can do.
  can: BackendInfo;
  onBack: () => void;
  onSay: (text: string, images: File[], queued: boolean, diffs: DiffQuote[], requestId: string) => Promise<boolean>;
  /// Put what is in the composer on the task list instead of saying it.
  onTask: (text: string, images: File[]) => Promise<boolean>;
  /// Work you said "not yet" to: what you type next is the correction.
  correcting: TaskItem | null;
  onCorrect: (text: string, images: File[], queued: boolean, taskId?: string) => Promise<boolean>;
  onStopCorrecting: () => void;
  /** Draw instead of describe: the edits become the message. */
  onSendDiagram: (edits: DiagramEdit[], note: string, queued: boolean) => void;
  onCreateDiagram: (about: string) => void;
  say: (text: string) => void;
  tags: string[];
  knownTags: string[];
  onTag: (change: { add?: string[]; remove?: string[]; set?: string[] }) => void;
  /// An empty reaction clears whatever was there.
  onReact: (entry: number, reaction: string) => void;
  /// Every model configured, so the picker can show the ones this
  /// session's harness can actually run.
  models: ModelInfo[];
  onModel: (model: string) => void;
  globalAutorun: boolean;
  onAutorun: (enabled: boolean | null) => Promise<void>;
  onInterrupt: () => void;
  /// Branch this session and read the branch here, in this pane.
  onFork: () => void;
  /// Branch it and put the branch in a pane of its own, beside this one.
  onForkBeside: () => void;
  /// Put another session beside this one, without branching it.
  onMerge: (() => void) | null;
  onOpenAgent: (id: string) => void;
  onRename: (name: string) => void;
  archived: boolean;
  onArchive: (archived: boolean) => void;
  busy: boolean;
  focusEntry: number | null;
  onEntryFocused: (entry: number) => void;
  /// Keep the call the agent is making now in view, rather than behind its
  /// toggle with the rest.
  verbose: boolean;
}) {
  const recommendationElement = useRef<HTMLElement>(null);
  const [changingAutorun, setChangingAutorun] = useState(false);
  const changeAutorun = async (enabled: boolean | null) => {
    setChangingAutorun(true);
    try { await onAutorun(enabled); }
    finally { setChangingAutorun(false); }
  };
  const [draft, setDraft] = useState(() => draftFor(view.agent.id));
  const [diffs, setDiffs] = useState(() => diffsFor(view.agent.id));
  const composed = [...diffs.map(quote => quote.text.trim()), draft.trim()].filter(Boolean).join("\n\n");
  const [reviewingGit, setReviewingGit] = useState<boolean | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [pending, setPending] = useState<Entry[]>([]);
  const retrySubmission = useRef<{ signature: string; requestId: string } | null>(null);
  const nextPending = useRef(0);
  const pictures = useUploads(view.agent.id);
  const pinned = usePinnedMessages(view.agent.id, say);
  const sendingPin = useRef<string | null>(null);
  const [pinPending, setPinPending] = useState<string | null>(null);
  const [draggingImages, setDraggingImages] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [quoteMenu, setQuoteMenu] = useState<LineMenu | null>(null);
  const selectedQuote = useRef<SelectedQuote | null>(null);
  const [discussion, setDiscussion] = useState<{ thread: QuoteThread; rect: DOMRect; ready?: Promise<QuoteThread> } | null>(null);
  const threadKey = JSON.stringify(quoteThreads);
  const threadData = useMemo(() => JSON.parse(threadKey) as QuoteThread[], [threadKey]);
  const closeDiscussion = useCallback(() => setDiscussion(null), []);
  const openDiscussion = useCallback((id: string, rect: DOMRect) => {
    const thread = threadData.find(thread => thread.agentId === id);
    if (thread) setDiscussion({ thread, rect });
  }, [threadData]);
  const quoteLinkValues = useMemo(() => new Map(threadData.map(thread => [thread.entryId, {
    threads: threadData.filter(other => other.entryId === thread.entryId), open: openDiscussion,
  }])), [threadData, openDiscussion]);
  const openingThreads = useRef(new Map<string, Promise<QuoteThread>>());
  const startDiscussion = (thread: QuoteThread, rect: DOMRect) => {
    const ready = openingThreads.current.get(thread.agentId) ?? api.quoteThread(thread.parentId, thread).then(({ agent }) => {
      const actual = { ...thread, agentId: agent.id };
      keepDraft(agent.id, draftFor(thread.agentId)); keepDraft(thread.agentId, "");
      onThreadsChanged();
      return actual;
    }).finally(() => openingThreads.current.delete(thread.agentId));
    openingThreads.current.set(thread.agentId, ready);
    setDiscussion({ thread, rect, ready });
  };
  const menu = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("type");
  const [edits, setEdits] = useState<DiagramEdit[]>([]);
  const [sketchReady, setSketchReady] = useState(false);
  const sketch = useRef<SketchHandle>(null);
  const { agent } = view;
  useEffect(() => {
    const reveal = () => {
      const query = new URLSearchParams(window.location.search);
      const review = query.get("review");
      if (query.get("agent") === agent.id && review) {
        setReviewId(review);
        setReviewingGit(true);
        setMode("type");
      }
    };
    reveal();
    window.addEventListener("popstate", reveal);
    return () => window.removeEventListener("popstate", reveal);
  }, [agent.id]);
  const latestReview = view.timeline.findLast(entry => entry.kind === "review");
  useEffect(() => {
    if (latestReview) preloadReview(reviewEndpoint(agent.id, latestReview.detail));
  }, [agent.id, latestReview?.detail]);
  const timeline = useRef<HTMLDivElement>(null);
  const timelineBody = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const loadingEarlier = useRef(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyAnchor = useRef<{ height: number; top: number; entry?: string; y?: number } | null>(null);
  const loadEarlier = async () => {
    const node = timeline.current;
    if (!node || !view.hasEarlier || loadingEarlier.current) return;
    loadingEarlier.current = true;
    setHistoryLoading(true);
    following.current = false;
    try {
      await onEarlier();
      const entry = [...node.querySelectorAll<HTMLElement>("[data-entry]")].find(entry => entry.getBoundingClientRect().top >= node.getBoundingClientRect().top);
      historyAnchor.current = { height: node.scrollHeight, top: node.scrollTop, entry: entry?.dataset.entry, y: entry?.getBoundingClientRect().top };
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    } finally {
      loadingEarlier.current = false;
      setHistoryLoading(false);
    }
  };
  useLayoutEffect(() => {
    const node = timeline.current;
    const anchor = historyAnchor.current;
    if (node && anchor) {
      const entry = anchor.entry ? node.querySelector<HTMLElement>(`[data-entry="${anchor.entry}"]`) : null;
      node.scrollTop = entry && anchor.y !== undefined
        ? node.scrollTop + (entry.getBoundingClientRect().top - anchor.y) / (node.getBoundingClientRect().height / node.offsetHeight)
        : anchor.top + node.scrollHeight - anchor.height;
      historyAnchor.current = null;
    }
  }, [view.timeline]);

  const previousAgent = useRef(agent.id);
  const [highlightedEntry, setHighlightedEntry] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // Native context menus can change Selection before DOM pointer events.
  // Keep the completed range until the reader starts another interaction.
  useEffect(() => {
    selectedQuote.current = null;
    const remember = () => {
      if (selectedQuote.current) return;
      const text = selectedText(timeline.current);
      if (!text) return;
      const start = window.getSelection()?.getRangeAt(0).startContainer;
      const row = (start instanceof Element ? start : start?.parentElement)?.closest("[data-entry]") ?? null;
      selectedQuote.current = { text, anchor: quoteAnchor(row, row ? Number(row.getAttribute("data-entry")) : null) };
    };
    const pointer = (event: PointerEvent) => {
      if ((event.button === 0 && !event.ctrlKey) || !timeline.current?.contains(event.target as Node)) selectedQuote.current = null;
    };
    const finishSelection = () => { selectedQuote.current = null; remember(); };
    const release = (event: PointerEvent) => {
      if (event.button === 0 && !event.ctrlKey && timeline.current?.contains(event.target as Node)) finishSelection();
    };
    document.addEventListener("selectionchange", remember);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("pointerup", release);
    document.addEventListener("keyup", finishSelection);
    return () => {
      document.removeEventListener("selectionchange", remember);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("keyup", finishSelection);
    };
  }, [agent.id]);
  const renameCancelled = useRef(false);
  const optimistic = useMemo(() => {
    const unmatched = [...pending];
    for (const entry of view.timeline) {
      const at = unmatched.findIndex((item) => entry.requestId === item.requestId);
      if (at >= 0) unmatched.splice(at, 1);
    }
    return unmatched;
  }, [pending, view.timeline]);
  useRecommendationExposure(agent.status === "complete" && optimistic.length === 0 ? view.nextActions?.recommendationId : undefined, recommendationElement);
  const items = useMemo(() => compactTimeline([...view.timeline, ...optimistic]), [view.timeline, optimistic]);
  const reviewTitles = useMemo(() => JSON.stringify(view.timeline.filter(entry => entry.kind === "review")
    .map(entry => [entry.detail, entry.text])), [view.timeline]);
  const reviewLinks = useMemo(() => ({
    titles: new Map<string, string>(JSON.parse(reviewTitles)),
    open: (id: string) => { setReviewId(id); setReviewingGit(true); setMode("type"); },
  }), [reviewTitles]);

  const [previousTimeline, setPreviousTimeline] = useState(view.timeline);
  if (previousTimeline !== view.timeline) {
    setPreviousTimeline(view.timeline);
    if (pending.length !== optimistic.length) setPending(optimistic);
  }

  useEffect(() => keepDraft(agent.id, draft), [agent.id, draft]);
  useEffect(() => keepDiffs(agent.id, diffs), [agent.id, diffs]);
  useEffect(() => {
    const receive = (event: Event) => {
      if ((event as CustomEvent<string>).detail === agent.id) { setDraft(draftFor(agent.id)); setDiffs(diffsFor(agent.id)); }
    };
    window.addEventListener(DRAFT_CHANGED, receive);
    return () => window.removeEventListener(DRAFT_CHANGED, receive);
  }, [agent.id]);

  /// Every question you asked, in order, so a question can lead to the one
  /// before or after it without reading everything in between.
  const asked = useMemo(
    () => view.timeline.filter((entry) => MINE.includes(entry.kind)).map((entry) => entry.id),
    [view.timeline],
  );

  /// Reading somewhere other than the tail, so streamed output stops
  /// dragging the view back down.
  const jumpTo = useCallback((id: number) => {
    following.current = false;
    timeline.current
      ?.querySelector<HTMLElement>(`[data-entry="${id}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const tail = view.timeline.at(-1);
  const tailRevision = `${tail?.id ?? ""}:${tail?.text ?? ""}:${tail?.detail ?? ""}:${tail?.output ?? ""}`;

  const pin = useCallback(() => {
    const node = timeline.current;
    if (node && following.current && !menu.current && !selectedText(node) && node.scrollHeight - node.clientHeight - node.scrollTop > 1) {
      node.scrollTo({ top: node.scrollHeight });
    }
  }, []);

  // Follow streamed updates while the reader is at the tail. Scrolling up
  // opts out until they return to the bottom; switching agents starts fresh.
  useEffect(() => {
    if (previousAgent.current !== agent.id) {
      previousAgent.current = agent.id;
      following.current = true;
      setHighlightedEntry(null);
    }
    const target = focusEntry
      ? timeline.current?.querySelector<HTMLElement>(`[data-entry="${focusEntry}"]`)
      : null;
    if (target) {
      following.current = false;
      setHighlightedEntry(focusEntry);
      target.scrollIntoView({ block: "center" });
      onEntryFocused(focusEntry!);
    } else pin();
  }, [tailRevision, agent.id, focusEntry, pin, onEntryFocused]);

  // A picture or a drawn diagram arrives after the scroll that revealed it,
  // and grows the timeline under the reader. Keep following the tail.
  useEffect(() => {
    const body = timelineBody.current;
    if (!body) return;
    const observer = new ResizeObserver(pin);
    observer.observe(body);
    return () => observer.disconnect();
  }, [agent.id, pin]);

  useEffect(() => {
    const input = composer.current;
    if (!input) return;
    input.style.height = "0px";
    const floor = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--cell"),
      10,
    );
    input.style.height = `${Math.max(floor || 34, Math.min(input.scrollHeight, 160))}px`;
    input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
    pin();
  }, [draft, diffs, pictures.uploads, pictures.error, pin]);

  /// Deliveries already explicitly requested, including idle sends and queued work.
  const sayImmediately = (text: string, images: File[], queued: boolean, restoreText = text, restoreDiffs: DiffQuote[] = []) => {
    const signature = JSON.stringify([agent.id, text, images.map(file => [file.name, file.size, file.type, file.lastModified]), queued, restoreDiffs]);
    const requestId = retrySubmission.current?.signature === signature ? retrySubmission.current.requestId : crypto.randomUUID();
    const id = --nextPending.current;
    const shown = images.length > 0
      ? [text, `Attached: ${images.map((image) => image.name).join(", ")}`].filter(Boolean).join("\n\n")
      : text;
    const entry: Entry = {
      id, agentId: agent.id, at: Date.now() / 1000, kind: "you", text: shown,
      detail: restoreDiffs.length ? `diff-attachments:${JSON.stringify(restoreDiffs)}` : "", output: "", origin: "", reaction: "", requestId,
    };
    setPending((current) => [...current, entry]);
    void onSay(text, images, queued, restoreDiffs, entry.requestId!).then((accepted) => {
      if (accepted) {
        if (retrySubmission.current?.requestId === requestId) retrySubmission.current = null;
        return;
      }
      retrySubmission.current = { signature, requestId };
      setPending((current) => current.filter((item) => item.id !== id));
      setDraft((current) => current ? `${restoreText}\n${current}` : restoreText);
      setDiffs(current => [...restoreDiffs, ...current]);
      pictures.add(images);
    });
  };

  const sendPinned = async (message = pinned.messages[0], queued = false) => {
    if (!message || busy || sendingPin.current) return;
    sendingPin.current = message.id; setPinPending(message.id);
    try {
      if (message.edits) await api.sendDiagram(agent.id, message.edits, message.text, queued);
      else if (message.correction) { if (!await onCorrect(message.text, message.files, queued, message.correction)) return; }
      else if (!await onSay(message.text, message.files, queued, message.diffs, message.id)) return;
      void pinned.remove(message.id);
    } catch (error) { say(error instanceof Error ? error.message : String(error)); }
    finally { sendingPin.current = null; setPinPending(null); }
  };

  const sendDrawn = async (queued: boolean) => {
    if (busy) return;
    const text = composed;
    if (mode === "diagram") {
      if (edits.length === 0) return;
      onSendDiagram(edits, text, queued);
      setEdits([]);
    } else {
      const picture = await sketch.current?.export();
      if (!picture) return;
      sayImmediately(text, [picture, ...pictures.files], queued, draft, diffs);
      pictures.clear();
      sketch.current?.clear();
    }
    setDraft("");
    setDiffs([]);
    // Back to the timeline, where what was just sent shows up.
    setMode("type");
  };

  const working = agent.status === "working";

  const canSend =
    mode === "type"
      ? !!correcting || draft.trim().length > 0 || diffs.length > 0 || pictures.uploads.length > 0 || pinned.messages.length > 0
      : mode === "diagram"
        ? edits.length > 0
        : sketchReady;

  const send = (queued = false) => {
    if (mode !== "type") {
      void sendDrawn(queued);
      return;
    }
    const text = composed;
    if (!correcting && !text && pictures.uploads.length === 0 && pinned.messages.length > 0) {
      void sendPinned(undefined, queued);
      return;
    }
    if ((!correcting && !text && pictures.uploads.length === 0) || busy) return;
    // What you just said is what you want to see, wherever you had scrolled
    // to before saying it.
    following.current = true;
    setDraft("");
    setDiffs([]);
    const sent = pictures.files;
    if (correcting) onCorrect(text, sent, queued);
    else sayImmediately(text, sent, queued, draft, diffs);
    pictures.clear();
  };

  // Arguing with finished work puts your hands in the box it is argued in.
  useEffect(() => {
    if (correcting) composer.current?.focus();
  }, [correcting]);

  /// The same thing you would have said, kept as work to do instead.
  /// The same thing you would have said, kept as work instead -- including
  /// a drawing, which until now only existed at the moment it was sent.
  const toTask = async () => {
    if (busy) return;
    const text = composed;
    const drawn = mode === "draw" ? await sketch.current?.export() : null;
    const filed = [...(drawn ? [drawn] : []), ...pictures.files];
    if (!text && filed.length === 0) return;
    setDraft("");
    setDiffs([]);
    const saving = onTask(text, filed);
    pictures.clear();
    if (drawn) {
      sketch.current?.clear();
      setMode("type");
    }
    if (!await saving) {
      setDraft((current) => current ? `${draft}\n${current}` : draft);
      setDiffs(current => [...diffs, ...current]);
      pictures.add(filed);
    }
  };

  // Drawing leaves the focus on the canvas, so tab is caught here as well
  // as in the message box: after a sketch, that is where your hands are.
  //
  // Attached once, and reading what it needs through a ref. Re-attaching on
  // every render loses the very key it is here for: the page's own handler
  // runs first, React flushes that render inside the same keydown, and a
  // listener removed mid-dispatch is not called.
  const drawTab = useRef<() => void>(() => {});
  useEffect(() => {
    drawTab.current = () => {
      if (mode === "draw") void toTask();
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.shiftKey || isTyping(event.target)) return;
      event.preventDefault();
      drawTab.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const finishRename = () => {
    const name = nameDraft.trim();
    setRenaming(false);
    if (name && name !== agent.name) onRename(name);
  };

  const quoteSelection = () => {
    if (!quoteMenu) return;
    const quote = quoteMenu.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    setDraft((current) => `${current}${current ? "\n\n" : ""}${quote}\n\n`);
    setQuoteMenu(null);
    window.requestAnimationFrame(() => composer.current?.focus());
  };

  return (
    <FileReviewProvider agent={agent.id}><ReviewLinks.Provider value={reviewLinks}>
    <section
      data-agent-panel
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!acceptsFileDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDraggingImages(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDraggingImages(false);
        }
      }}
      onDrop={(event) => {
        if (!acceptsFileDrop(event.dataTransfer)) return;
        event.preventDefault();
        setDraggingImages(false);
        void pictures.addFromDrop(event.dataTransfer);
      }}
    >
      {/* One row, whatever the width: what cannot fit is cut, not wrapped,
          because a header that grows downwards takes the conversation's
          space to say what it already said. */}
      {/* Nothing here overflows -- the parts that could truncate themselves --
          and a menu dropping out of a button needs to be allowed out. */}
      <div data-pane-header className="relative z-20 flex h-[var(--bar)] shrink-0 items-center gap-x-[10px] border-b border-rule pl-3">
        {paneHandle}
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer text-[13px] text-mid hover:text-ink"
          aria-label="back to the fleet"
          title="Back to fleet"
        >
          <Icon name="back" />
        </button>
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => {
              if (renameCancelled.current) {
                renameCancelled.current = false;
                setRenaming(false);
              } else {
                finishRename();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") finishRename();
              if (event.key === "Escape") {
                renameCancelled.current = true;
                event.currentTarget.blur();
              }
            }}
            aria-label="session title"
            className="min-w-32 border-b border-edge bg-transparent px-0 py-1 text-[15px] font-semibold outline-none focus:border-ink"
            style={{ width: `${Math.min(Math.max(nameDraft.length + 1, 12), 42)}ch` }}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameDraft(agent.name);
              setRenaming(true);
            }}
            className={`max-w-[40%] shrink-0 cursor-text truncate text-[16px] font-semibold hover:underline ${agent.status === "working" ? "text-ok" : agent.status === "stalled" ? "text-hold" : ""}`}
            title="rename"
            data-pane-title
          >
            {agent.name}
          </button>
        )}
        {/* It gives up its width first, but never all of it: what an agent
            is doing now is the thing this line is for. */}
        <span className="min-w-[86px] flex-1 truncate text-[12.5px] text-faint">
          {agent.status} {since(agent.updatedAt)} · {agent.backend} ·{" "}
          {/* The model was printed here as a fact about the session. It is a
              decision about the session, and the place you read it is the
              place you would go to change it. */}
          <select
            value={agent.model}
            onChange={(event) => onModel(event.target.value)}
            aria-label="model"
            title="Model"
            className="cursor-pointer appearance-none bg-transparent text-[12.5px] text-faint underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            {models.filter((option) => option.backend === agent.backend).length === 0 && (
              <option value={agent.model}>{agent.model}</option>
            )}
            {models
              .filter((option) => option.backend === agent.backend)
              .map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
          </select>{" "}
          · {view.delivery}
        </span>

        <span className="flex max-w-[45%] shrink items-center overflow-hidden">
          <TagEditor
            tags={tags}
            known={knownTags}
            busy={busy}
            onAdd={(tag) => onTag(tagChange(tag))}
            onRemove={(tag) => onTag({ remove: [tag] })}
          />
        </span>


        <span className="flex shrink-0 items-stretch self-stretch border-l border-rule">
        {agent.permalink && (
          <a
            href={agent.permalink}
            target="_blank"
            rel="noreferrer"
            aria-label="open in Slack"
            title="Open in Slack"
            className="flex h-[var(--cell)] w-[var(--cell)] items-center justify-center border-r border-rule text-mid hover:text-ink"
          >
            <Icon name="external" size={14} />
          </a>
        )}
        <button
          type="button"
          onClick={() => onArchive(!archived)}
          disabled={busy || (!archived && agent.status === "working")}
          aria-label={archived ? "restore session" : "archive session"}
          title={!archived && agent.status === "working" ? "Stop the active turn first" : archived ? "Restore session" : "Archive session"}
          className="flex h-[var(--cell)] w-[var(--cell)] cursor-pointer items-center justify-center border-r border-rule text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name={archived ? "restore" : "archive"} size={14} />
        </button>
        {reviewId && <button aria-label="Open change review" title="Open change review" aria-pressed={reviewingGit === true}
          onClick={() => { setReviewingGit(value => !value); setMode("type"); }}
          className="flex cursor-pointer items-center justify-center px-3 text-mid hover:text-ink">
          <Icon name="diff" size={14} />
        </button>}
        <SplitAction label="Conversation autorun" icon="play" pressed={view.autorun ?? globalAutorun} disabled={changingAutorun}
          hint={`Autorun ${view.autorun ?? globalAutorun ? "on" : "off"}${view.autorun == null ? " · using global setting" : " · this conversation"}`}
          onClick={() => void changeAutorun(!(view.autorun ?? globalAutorun))}
          menu={[
            {label: "Use global setting", icon: view.autorun == null ? "tick" : "settings", checked: view.autorun == null, onClick: () => void changeAutorun(null)},
            {label: "Autorun on", icon: view.autorun === true ? "tick" : "play", checked: view.autorun === true, onClick: () => void changeAutorun(true)},
            {label: "Autorun off", icon: view.autorun === false ? "tick" : "stop", checked: view.autorun === false, onClick: () => void changeAutorun(false)},
          ]} />
        <SplitAction
          label={can.fork ? "Fork in chat" : `${agent.backend} cannot fork a session`}
          icon="fork"
          onClick={onFork}
          disabled={busy || !can.fork}
          menu={[{ label: "Fork to separate thread", icon: "split", onClick: onForkBeside }]}
        />
        {onMerge && (
          <button
            type="button"
            onClick={onMerge}
            disabled={busy || agent.status === "working" || !can.merge}
            aria-label="merge into parent"
            title={
              !can.merge
                ? `${agent.backend} cannot fold a fork back in`
                : agent.status === "working"
                  ? "Stop the active turn first"
                  : "Merge into parent"
            }
            className="flex h-[var(--cell)] w-[var(--cell)] cursor-pointer items-center justify-center border-r border-rule text-merge hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="merge" size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={onInterrupt}
          disabled={busy || agent.status !== "working"}
          aria-label="stop the turn"
          title="Stop the turn"
          className="flex h-[var(--cell)] w-[var(--cell)] cursor-pointer items-center justify-center text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="stop" size={14} />
        </button>
        </span>
      </div>

      {reviewId && <div hidden={!reviewingGit} className="flex min-h-0 flex-1 flex-col"><GitReview key={reviewId} agentId={agent.id} reviewId={reviewId} onRevised={setReviewId} active={reviewingGit === true} onClose={() => setReviewingGit(false)} onQuote={quote => {
        setDiffs(current => [...current, quote]);
        setMode("type");
        setReviewingGit(false);
        window.requestAnimationFrame(() => composer.current?.focus());
      }} /></div>}
      {mode === "diagram" && (
        <DiagramComposer
          agentId={agent.id}
          edits={edits}
          onEdits={setEdits}
          onCreate={(about) => {
            onCreateDiagram(about);
            setMode("type");
          }}
          say={say}
          busy={busy}
        />
      )}
      {mode === "draw" && <Sketch ref={sketch} onChange={setSketchReady} say={say} />}

      <div
        ref={timeline}
        hidden={mode !== "type" || reviewingGit === true}
        onPointerDown={(event) => {
          if ((event.button === 2 || (event.button === 0 && event.ctrlKey)) && selectedQuote.current) event.preventDefault();
        }}
        onContextMenu={(event) => {
          // Use the completed selection, before focus or context-click changes it.
          const selected = selectedQuote.current;
          selectedQuote.current = null;
          const row = (event.target as HTMLElement).closest("[data-entry]");
          const id = row ? Number(row.getAttribute("data-entry")) : null;
          const entry = id !== null && Number.isFinite(id) ? id : null;
          const line = view.timeline.find((line) => line.id === entry);
          const text = selected?.text || selectedText(timeline.current) || line?.text.trim() || "";
          // Nothing selected and nothing under the cursor means the browser's
          // own menu is the more useful one.
          if (!text && entry === null) return;
          event.preventDefault();
          setQuoteMenu({
            anchor: selected ? selected.anchor : quoteAnchor(row, entry),
            text,
            entry,
            reaction: line?.reaction ?? "",
            slackUrl: line?.slackUrl ?? "",
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - (entry === null ? 38 : 190) - 8)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 46)),
          });
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          if (node.scrollTop < 80) void loadEarlier();
        }}
        onWheel={() => setQuoteMenu(null)}
        onTouchMove={() => setQuoteMenu(null)}
        data-transcript
        className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-[var(--pane-x)] py-2"
      >
        <div ref={timelineBody}>
          {view.hasEarlier && <button type="button" disabled={historyLoading} onClick={() => void loadEarlier()} className="mb-3 cursor-pointer text-[12px] text-faint hover:text-ink">{historyLoading ? "Loading earlier messages…" : "Load earlier messages"}</button>}
          {initialPreview !== undefined && optimistic.length === 0 ? (
            <Markdown>{initialPreview}</Markdown>
          ) : items.length === 0 ? (
            <p className="text-[13px] text-faint">Nothing on the timeline yet.</p>
          ) : (
            items.map((item, at) => {
              if ("tools" in item) {
                return <ToolGroup key={`tools-${item.tools[0].id}`} entries={item.tools} showLatest={verbose && at === items.length - 1} />;
              }

              const { entry } = item;
              if (entry.kind === "you" && entry.detail.startsWith("review-approval:")) {
                const approval = JSON.parse(entry.detail.slice("review-approval:".length)) as { id: string; title: string; commit: string; branch: string; base: string };
                return <div key={entry.id} data-entry={entry.id} role="region" aria-label="Publication approval" className="border-b border-hair py-3">
                  <button aria-label={`Review approved change ${approval.title}`} onClick={() => { setReviewId(approval.id); setReviewingGit(true); setMode("type"); }} className="flex w-full cursor-pointer items-center gap-3 text-left hover:bg-band">
                    <Icon name="tick" />
                    <span className="min-w-0 flex-1 font-semibold">PR approved: {approval.title}</span>
                    <Icon name="external" size={14} />
                  </button>
                </div>;
              }
              if (entry.kind === "review") return <div key={entry.id} data-entry={entry.id} className="border-b border-hair py-3">
                <button aria-label={`Review ${entry.text}`} onClick={() => { setReviewId(entry.detail); setReviewingGit(true); setMode("type"); }}
                  className="flex w-full cursor-pointer items-center gap-3 text-left hover:bg-band">
                  <Icon name="diff" />
                  <span className="min-w-0 flex-1"><span className="block font-semibold">{entry.text}</span><span className="text-[12px] text-faint">Local change · Review before publication</span></span>
                  <Icon name="external" size={14} />
                </button>
              </div>;
              return (
                <QuoteLinks.Provider key={entry.id} value={quoteLinkValues.get(entry.id) ?? null}><Message
                  key={entry.id}
                  entry={entry}
                  focused={entry.id === (focusEntry ?? highlightedEntry)}
                  asked={asked}
                  onJump={jumpTo}
                  onOpenAgent={onOpenAgent}
                /></QuoteLinks.Provider>
              );
            })
          )}
          {agent.status === "complete" && optimistic.length === 0 && view.nextActions && (
            <section ref={recommendationElement} aria-label="Suggested next steps" role="group" className="next-choices">
              <h3>Next</h3>
              <div>
                {view.nextActions.actions.map(action => <button key={action.message} type="button" aria-label={action.label} title={action.message}
                  disabled={busy} onClick={() => sayImmediately(action.message, [], false)}
                  className="cursor-pointer text-left hover:bg-wash focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-40">
                  <span>{action.label}</span><span>{action.message}</span>
                </button>)}
              </div>
            </section>
          )}
        </div>
      </div>

      {quoteMenu && (
        <div
          role="group"
          aria-label="message actions"
          autoFocus
          tabIndex={-1}
          ref={(node) => {
            menu.current = node;
            node?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") setQuoteMenu(null);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setQuoteMenu(null);
            }
          }}
          onPointerDown={(event) => event.preventDefault()}
          style={{ left: quoteMenu.x, top: quoteMenu.y }}
          className="fixed z-40 flex border border-edge bg-card text-ink shadow-[0_8px_24px_rgba(33,29,25,0.16)] outline-none"
        >
          {quoteMenu.text && (
            <button
              type="button"
              onClick={quoteSelection}
              aria-label="quote reply"
              title="Quote reply"
              className="flex h-9 w-9 cursor-pointer items-center justify-center hover:bg-wash"
            >
              <Icon name="quote" />
            </button>
          )}
          {quoteMenu.anchor && <button type="button" aria-label="quote into thread" title="Quote into thread"
            disabled={busy || !can.fork} className="flex h-9 w-9 cursor-pointer items-center justify-center hover:bg-wash disabled:opacity-30"
            onClick={() => {
              const anchor = quoteMenu.anchor!;
              const thread = { ...anchor, agentId: `quote:${agent.id}:${anchor.entryId}:${anchor.start}:${anchor.end}`, parentId: agent.id };
              const rect = new DOMRect(quoteMenu.x, quoteMenu.y, 0, 0);
              setQuoteMenu(null); window.getSelection()?.removeAllRanges();
              startDiscussion(thread, rect);
            }}><Icon name="thread" /></button>}
          {quoteMenu.slackUrl && (
            <a
              href={quoteMenu.slackUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="open in Slack"
              title="Open in Slack"
              onClick={() => setQuoteMenu(null)}
              className="flex h-9 w-9 items-center justify-center hover:bg-wash"
            >
              <Icon name="external" />
            </a>
          )}
          {quoteMenu.entry !== null &&
            REACTIONS.map((choice) => {
              const on = quoteMenu.reaction === choice.key;
              return (
                <button
                  key={choice.key}
                  type="button"
                  // The same one again takes it back, so a misclick costs
                  // one more click rather than a trip to a menu.
                  onClick={() => {
                    onReact(quoteMenu.entry as number, on ? "" : choice.key);
                    setQuoteMenu(null);
                  }}
                  aria-label={choice.label}
                  aria-pressed={on}
                  title={choice.label}
                  className={`flex h-9 w-9 cursor-pointer items-center justify-center hover:bg-wash ${
                    on ? "bg-band text-ink" : "text-mid"
                  }`}
                >
                  <Icon name={choice.icon} size={14} />
                </button>
              );
            })}
        </div>
      )}

      <footer
        className={`flex shrink-0 flex-col border-t ${
          draggingImages ? "border-drop bg-wash" : "border-rule bg-card"
        }`}
      >
        {pinned.saving && <span aria-label="Saving pinned messages" className="sr-only">Saving</span>}
        {pinned.messages.length > 0 && <ol aria-label="Pinned messages" className="quiet-scroll max-h-48 overflow-auto px-[var(--pane-x)] py-2">
          {pinned.messages.map(message => <li key={message.id} data-pinned-message={message.id} className="flex items-center gap-2 py-1 text-[12px] text-mid">
            <div className="min-w-0 flex-1"><p className="line-clamp-3 whitespace-pre-wrap">{message.text || (message.edits ? "Drawn change" : "Attached files")}</p>{message.files.length > 0 && <p className="truncate text-[11px] text-faint">{message.files.map(file => file.name).join(", ")}</p>}</div>
            <button type="button" aria-label="Send pinned message now" title="Send now" disabled={busy || pinPending !== null} onClick={() => void sendPinned(message)} className="cursor-pointer p-1 text-mid hover:text-ink disabled:opacity-30"><svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 14V2M3 7l5-5 5 5" /></svg></button>
            <button type="button" aria-label="Discard pinned message" title="Discard" disabled={pinPending !== null} onClick={() => pinned.remove(message.id)} className="cursor-pointer p-1 text-faint hover:text-ink disabled:opacity-30"><Icon name="discard" size={14} /></button>
          </li>)}
        </ol>}
        {mode !== "type" && (
          <div className="flex items-center gap-2 px-[var(--pane-x)] pt-[6px] text-[11.5px] text-faint">
            <Icon name={MODES.find((option) => option.mode === mode)?.icon ?? "pen"} size={13} />
            {MODES.find((option) => option.mode === mode)?.label}
            {mode === "diagram" && edits.length > 0 && (
              <span className="tnum text-[10.5px] text-ok">{edits.length}</span>
            )}
            <button
              type="button"
              onClick={() => setMode("type")}
              className="cursor-pointer text-faint hover:text-ink"
            >
              back to typing
            </button>
          </div>
        )}
        {correcting && (
          <div className="flex items-center gap-2 px-[var(--pane-x)] pt-[6px] text-[11.5px] text-faint">
            <Icon name="quote" size={13} />
            <span className="min-w-0 flex-1 truncate text-mid">Not yet: {correcting.text}</span>
            <button
              type="button"
              onClick={onStopCorrecting}
              title="Say it to the agent instead"
              className="cursor-pointer px-1 hover:text-ink"
            >
              ×
            </button>
          </div>
        )}
        <Attachments
          uploads={pictures.uploads}
          error={pictures.error}
          dragging={draggingImages}
          onDrop={pictures.drop}
        />
        <div className="px-3">{diffs.map((quote, index) => <DiffAttachment key={index} quote={quote} onRemove={() => setDiffs(current => current.filter((_, at) => at !== index))} />)}</div>
        <div className="flex items-stretch">
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              pictures.add(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <SplitAction
            label="Attach files"
            icon="attach"
            onClick={() => picker.current?.click()}
            disabled={busy}
            from="left"
            menu={MODES.filter((option) => option.mode !== "type").map((option) => ({
              label: option.label,
              icon: option.icon,
              onClick: () => setMode(option.mode),
            }))}
            up
          />
          <textarea
            ref={composer}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                pictures.add(files);
              }
            }}
            onKeyDown={(event) => {
              // Enter sends immediately; Shift+Enter keeps a newline.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
              // Tab saves correction feedback on the task; otherwise it files a new task.
              if (event.key === "Tab" && !event.shiftKey && mode !== "diagram") {
                event.preventDefault();
                if (correcting) send(true);
                else void toTask();
              }
            }}
            rows={1}
            data-composer
            placeholder={correcting ? "What is still wrong?" : mode === "type" ? "" : PLACEHOLDER[mode]}
            className="min-h-[var(--cell)] min-w-0 flex-1 resize-none overflow-y-hidden border-x border-rule bg-paper px-3 py-[8px] text-[var(--said)] leading-[1.35] outline-none placeholder:text-faint"
          />
          {mode === "type" ? (
            <SplitAction
              label="Send message"
              hint="Send message"
              icon="send"
              onClick={() => send()}
              disabled={busy || !canSend}
              menu={[
                ...(working
                  ? [{ label: "Queue after this turn", icon: "queue" as const, onClick: () => send(true) }]
                  : []),
                { label: "Add to the task list", icon: "tasks" as const, onClick: () => void toTask() },
              ]}
              up
            />
          ) : (
            // A drawing is made at the moment it is sent, so there is
            // nothing yet to put on the task list.
            <SplitAction
              label={mode === "diagram" ? "Send the change" : "Send the picture"}
              hint={mode === "diagram" ? "Send the change" : "Send the picture"}
              icon="send"
              onClick={() => send()}
              disabled={busy || !canSend}
              menu={[
                ...(working
                  ? [
                      {
                        label: "Queue after this turn",
                        icon: "queue" as const,
                        onClick: () => send(true),
                      },
                    ]
                  : []),
                // A drawn change is an edit to a file, and a task cannot
                // carry one; a picture it can.
                ...(mode === "draw"
                  ? [{ label: "Add to the task list", icon: "tasks" as const, onClick: () => void toTask() }]
                  : []),
              ]}
              up
            />
          )}
        </div>
      </footer>
    </section>
    {discussion && <QuoteDiscussion key={discussion.thread.agentId} thread={discussion.thread} ready={discussion.ready} onRetry={() => startDiscussion(discussion.thread, discussion.rect)} rect={discussion.rect} onClose={closeDiscussion} onChanged={onThreadsChanged} onOpen={id => { onOpenAgent(id); closeDiscussion(); }} siblings={threadData.filter(thread => thread.entryId === discussion.thread.entryId && thread.start < discussion.thread.end && thread.end > discussion.thread.start)} onSwitch={thread => setDiscussion({ thread, rect: discussion.rect })} canMerge={can.merge} />}
    </ReviewLinks.Provider></FileReviewProvider>
  );
}

/**
 * Something you sent. A drawn diagram change shows as the diagram, and a
 * picture as the picture, with the words the agent got one click away.
 */
/// One tool call, whole: when it ran, what it ran, and whatever it printed.
///
/// The time carries the news. A group that is still being added to looks
/// the same from one second to the next unless each call says when it
/// happened, so this column is darker than the summary above it.
const ToolGroup = memo(function ToolGroup({ entries, showLatest }: { entries: Entry[]; showLatest: boolean }) {
  const [open, setOpen] = useState(false);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const loaded = useRef(new Map<number, Entry>());
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const latest = showLatest ? entries.at(-1) : null;
  const folded = showLatest ? entries.slice(0, -1) : entries;
  const visible = useMemo(() => open ? entries : showLatest ? entries.slice(-1) : [], [entries, open, showLatest]);
  useEffect(() => {
    const wanted = new Set(visible.filter(entry => entry.outputDeferred).map(entry => entry.id));
    for (const id of loaded.current.keys()) if (!wanted.has(id)) loaded.current.delete(id);
    setOutputs(current => Object.fromEntries(Object.entries(current).filter(([id]) => wanted.has(Number(id)))));
    // A refreshed page replaces entry objects; unrelated live events preserve them.
    const deferred = visible.filter(entry => entry.outputDeferred && loaded.current.get(entry.id) !== entry);
    setError("");
    if (!deferred.length) return;
    const controller = new AbortController();
    void api.toolOutputs(deferred[0].agentId, deferred[0].id, deferred.at(-1)!.id, controller.signal).then(saved => {
      if (controller.signal.aborted) return;
      if (deferred.some(entry => !(entry.id in saved))) throw new Error("Tool output is no longer available");
      for (const entry of deferred) loaded.current.set(entry.id, entry);
      setOutputs(current => ({ ...current, ...saved }));
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [visible, attempt]);
  const tool = (entry: Entry) => <ToolCall key={entry.id} entry={entry} output={outputs[entry.id]} />;
  return <div className="border-b border-hair py-2">
    {folded.length > 0 && <details className="group" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-3 text-[11.5px] text-faint marker:content-none hover:text-mid">
        <span data-message-time className="tnum w-[34px] shrink-0 text-[10.5px] text-mid">{minute(folded.at(-1)!.at)}</span>
        <span className="w-2 text-center group-open:rotate-90">›</span>
        <span className="shrink-0">{folded.length} tool {folded.length === 1 ? "call" : "calls"}</span>
      </summary>
      {open && <div className="mt-1 flex flex-col">{folded.map(tool)}</div>}
    </details>}
    {latest && <div className="flex flex-col">{tool(latest)}</div>}
    {error && <p role="alert" className="text-[12px] text-remove">{error} <button className="cursor-pointer underline" onClick={() => retry(value => value + 1)}>Retry</button></p>}
  </div>;
});

function ToolCall({ entry, output }: { entry: Entry; output?: string }) {
  const printed = entry.outputDeferred ? output : entry.output;
  return (
    <div className="flex gap-3 border-t border-hair py-[7px] text-[11.5px] leading-[1.45] text-mid">
      <span data-message-time className="tnum w-[34px] shrink-0 text-[10.5px] text-mid">{minute(entry.at)}</span>
      <div className="min-w-0 flex-1">
        {entry.text !== "Command" && <span className="mr-2 text-faint">{entry.text}</span>}
        <div className="break-words whitespace-pre-wrap">
          <Code text={entry.detail || entry.text} />
        </div>
        {entry.outputDeferred && printed === undefined && <p className="mt-2 text-faint">Loading output…</p>}
        {printed && (
          <Copyable>
            <pre className="quiet-scroll mt-2 max-h-64 overflow-auto bg-band p-2 font-mono text-[11px] leading-[1.4] text-ink whitespace-pre-wrap">
              {printed}
            </pre>
          </Copyable>
        )}
      </div>
    </div>
  );
}

/// Anything anyone said: the words, and whatever came with them.
function Said({ text, detail }: { text: string; detail: string }) {
  const diffs: DiffQuote[] = detail.startsWith("diff-attachments:") ? JSON.parse(detail.slice("diff-attachments:".length)) : [];
  for (const quote of diffs) text = text.slice(quote.text.trim().length).trimStart();
  const { body, names } = splitAttached(text);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {diffs.map((quote, index) => <DiffAttachment key={index} quote={quote} />)}
      {body.trim() && (body.includes("```mermaid") ? <DiagramMessage text={body} /> : <Markdown>{body}</Markdown>)}
      {names.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {names.map((name) => (
            <Attached key={name} name={name} />
          ))}
        </div>
      )}
    </div>
  );
}

/// One message, drawn once.
///
/// Typing in the composer changes state on the panel, and without this
/// every keystroke re-rendered every message in the conversation --
/// Markdown and all -- which is what made a long session feel slow to type
/// in. The entry objects are stable between renders, so memo holds.
const Message = memo(function Message({
  entry,
  focused,
  asked,
  onJump,
  onOpenAgent,
}: {
  entry: Entry;
  focused: boolean;
  /// The ids of every question asked, so a question can point at its
  /// neighbours.
  asked: number[];
  onJump: (id: number) => void;
  onOpenAgent: (id: string) => void;
}) {
  const tag = TAG[entry.kind];
  const mine = MINE.includes(entry.kind);
  return (
        <div
          key={entry.id}
          data-entry={entry.id}
          className={[
            "flex items-start gap-3 border-b border-hair py-[var(--row-y)] last:border-b-0",
            // The whole row, so what you said is found by running
            // your eye down the column rather than reading it.
            mine ? "group -mx-[var(--pane-x)] bg-mine px-[var(--pane-x)]" : "",
            focused ? "bg-band" : "",
          ].join(" ")}
        >
          <span data-message-time className="tnum w-[34px] shrink-0 pt-[3px] text-[10.5px] text-mid">
            {minute(entry.at)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <div className="flex min-w-0 items-start gap-2 text-[var(--said)] leading-[1.55] break-words">
              {tag && (
                <span className={`shrink-0 pt-[2px] text-[10.5px] ${tag.tone}`}>
                  {tag.label}
                </span>
              )}
              <Said text={entry.text} detail={entry.detail} />
            </div>
            {entry.reaction && (
              <span className="flex items-center text-mid">
                <Icon name={entry.reaction === "down" ? "thumbDown" : "thumbUp"} size={12} />
              </span>
            )}
            {entry.origin && <span className="text-[11px] text-ok">← {entry.origin}</span>}
            {(["forked", "forkedFrom", "merged", "mergedInto"] as EntryKind[]).includes(entry.kind) && entry.detail ? (
              <button
                type="button"
                onClick={() => onOpenAgent(entry.detail)}
                aria-label={entry.kind === "merged" ? "open source session" : entry.kind === "mergedInto" ? "open destination session" : entry.kind === "forked" ? "open child session" : "open parent session"}
                title={entry.kind === "merged" ? "Open source session" : entry.kind === "mergedInto" ? "Open destination session" : entry.kind === "forked" ? "Open child session" : "Open parent session"}
                className="flex h-6 w-6 cursor-pointer items-center justify-center text-merge"
              >
                <Icon name="open" size={13} />
              </button>
            ) : entry.detail && !entry.detail.startsWith("diff-attachments:") ? (
              <span className="text-[11px] text-faint">{entry.detail}</span>
            ) : null}
          </div>
          {mine && asked.length > 1 && (
            <span className="flex shrink-0 items-center gap-[2px] opacity-0 transition-opacity group-hover:opacity-100">
              {(
                [
                  ["the question before this", asked[asked.indexOf(entry.id) - 1], "rotate-180"],
                  ["the question after this", asked[asked.indexOf(entry.id) + 1], ""],
                ] as const
              ).map(([label, to, turn]) => (
                <button
                  key={label}
                  type="button"
                  disabled={to === undefined}
                  onClick={() => to !== undefined && onJump(to)}
                  aria-label={label}
                  title={label}
                  className={`flex h-6 w-6 cursor-pointer items-center justify-center text-faint hover:text-ink disabled:cursor-default disabled:opacity-25 ${turn}`}
                >
                  <Icon name="chevronDown" size={12} />
                </button>
              ))}
            </span>
          )}
        </div>
      );
});

/// Preview media inline; offer other artifacts as downloads.
function Attached({ name }: { name: string }) {
  const [missing, setMissing] = useState(false);
  const url = `/api/attachments/${encodeURIComponent(name)}`;
  const shape = "max-h-64 max-w-[min(520px,100%)] rounded-[3px] border border-rule";
  if (missing) return <span className="text-[12px] text-faint">{name}</span>;
  if (/\.(mp4|m4v|webm|mov)$/i.test(name)) {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        title={name}
        onError={() => setMissing(true)}
        className={shape}
      />
    );
  }
  if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) {
    const label = name.startsWith("art_") ? name.slice(name.indexOf("-") + 1) : name;
    return (
      <span className="inline-flex items-center"><a href={url} download={label} title="Download file" className="flex items-center gap-2 text-[13px] text-ink underline underline-offset-2">
        <Icon name="attach" />
        {label}
      </a><ReviewFileButton url={url} /></span>
    );
  }
  return (
    <ReviewImage src={url} alt={name} onError={() => setMissing(true)} className={shape} />
  );
}

function DiagramMessage({ text }: { text: string }) {
  const source = text.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? "";
  // The boxes this change added, coloured the way the editor showed them.
  const added = [...text.matchAll(/^- New component `(\w+)`/gm)].map((match) => match[1]).join(",");
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.renderDiagram(source, added ? added.split(",") : []).then(
      (drawn) => live && setSvg(drawn.svg),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [source, added]);
  const lines = text.split("\n");
  const changes = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  const firstChange = lines.findIndex((line) => line.startsWith("- "));
  const note = lines.slice(1, firstChange < 0 ? 1 : firstChange).join("\n").trim();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="flex items-center gap-2 text-[13px] text-mid">
        <Icon name="diagram" size={14} />
        Drew a change to the architecture
      </span>
      {note && <Markdown>{note}</Markdown>}
      <ul className="flex flex-col gap-[2px] text-[13.5px] leading-[1.45]">
        {changes.map((change, index) => (
          <li key={index} className="flex gap-2">
            <span className="text-ok">+</span>
            <span className="min-w-0">
              <Markdown>{change}</Markdown>
            </span>
          </li>
        ))}
      </ul>
      {svg && (
        <div
          className="max-w-[560px] rounded-[3px] border border-rule bg-[#fbf9f6] [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: svg.replace(/^<\?xml[^>]*>\s*/, "") }}
        />
      )}
      <details className="text-[12.5px] text-mid">
        <summary className="cursor-pointer text-faint hover:text-mid">What the agent was told</summary>
        <div className="mt-2 text-[13px]">
          <Markdown>{text}</Markdown>
        </div>
      </details>
    </div>
  );
}
