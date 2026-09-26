"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { clock, since } from "../lib/format";
import { isTyping } from "../lib/keys";
import type { AgentView, BackendInfo, DiagramEdit, Entry, EntryKind } from "../lib/types";
import { DiagramComposer } from "./composer/DiagramComposer";
import { Sketch, type SketchHandle } from "./composer/Sketch";
import { draftFor, keepDraft } from "../lib/drafts";
import { TagEditor, tagChange } from "./Tags";
import { Icon, type IconName } from "./Icon";
import { Markdown } from "./Markdown";
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
type Upload = { file: File; preview: string };
type QuoteMenu = { text: string; x: number; y: number };

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
  can,
  onBack,
  onSay,
  onTask,
  onInterrupt,
  onForkSlack,
  onForkLocal,
  onOpenBeside,
  onMerge,
  onOpenAgent,
  onRename,
  archived,
  onArchive,
  busy,
  focusEntry,
  onSendDiagram,
  onCreateDiagram,
  say,
  tags,
  knownTags,
  onTag,
}: {
  view: AgentView;
  /// What this agent's harness can do.
  can: BackendInfo;
  onBack: () => void;
  onSay: (text: string, images: File[], queued: boolean) => void;
  /// Put what is in the composer on the task list instead of saying it.
  onTask: (text: string, images: File[]) => void;
  /** Draw instead of describe: the edits become the message. */
  onSendDiagram: (edits: DiagramEdit[], note: string, queued: boolean) => void;
  onCreateDiagram: (about: string) => void;
  say: (text: string) => void;
  tags: string[];
  knownTags: string[];
  onTag: (change: { add?: string[]; remove?: string[]; set?: string[] }) => void;
  onInterrupt: () => void;
  onForkSlack: () => void;
  onForkLocal: () => void;
  /// Put another session beside this one, without branching it.
  onOpenBeside: () => void;
  onMerge: (() => void) | null;
  onOpenAgent: (id: string) => void;
  onRename: (name: string) => void;
  archived: boolean;
  onArchive: (archived: boolean) => void;
  busy: boolean;
  focusEntry: number | null;
}) {
  const [draft, setDraft] = useState(() => draftFor(view.agent.id));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [draggingImages, setDraggingImages] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [quoteMenu, setQuoteMenu] = useState<QuoteMenu | null>(null);
  const [mode, setMode] = useState<Mode>("type");
  const [edits, setEdits] = useState<DiagramEdit[]>([]);
  const [sketchReady, setSketchReady] = useState(false);
  const sketch = useRef<SketchHandle>(null);
  const { agent } = view;
  const timeline = useRef<HTMLDivElement>(null);
  const timelineBody = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previousAgent = useRef(agent.id);
  const picker = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const uploadsRef = useRef<Upload[]>([]);
  const renameCancelled = useRef(false);
  const items = compactTimeline(view.timeline);

  useEffect(() => keepDraft(agent.id, draft), [agent.id, draft]);

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

  // Follow streamed updates while the reader is at the tail. Scrolling up
  // opts out until they return to the bottom; switching agents starts fresh.
  useEffect(() => {
    if (previousAgent.current !== agent.id) {
      previousAgent.current = agent.id;
      following.current = true;
    }
    const target = focusEntry
      ? timeline.current?.querySelector<HTMLElement>(`[data-entry="${focusEntry}"]`)
      : null;
    if (target) target.scrollIntoView({ block: "center" });
    else if (following.current) timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [tailRevision, agent.id, focusEntry]);

  /// Hold the reader at the tail. The composer grows as you type, which
  /// takes its height from the transcript, so what you were reading slides
  /// under the box unless the scroll follows it down.
  const pin = useCallback(() => {
    const node = timeline.current;
    if (node && following.current) node.scrollTo({ top: node.scrollHeight });
  }, []);

  // A picture or a drawn diagram arrives after the scroll that revealed it,
  // and grows the timeline under the reader. Keep following the tail.
  useEffect(() => {
    const body = timelineBody.current;
    if (!body) return;
    const observer = new ResizeObserver(() => {
      if (following.current) timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [agent.id]);

  const addFiles = useCallback((files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    setAttachmentError(images.length === files.length ? "" : "Only image files are supported.");
    setUploads((current) => [
      ...current,
      ...images.map((file) => ({ file, preview: URL.createObjectURL(file) })),
    ]);
  }, []);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

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
  }, [draft, uploads, attachmentError, pin]);

  useEffect(() => () => {
    uploadsRef.current.forEach((upload) => URL.revokeObjectURL(upload.preview));
  }, []);

  /// A drawing is a message like any other, so it can wait for the turn
  /// that is running rather than landing in the middle of it.
  const sendDrawn = async (queued: boolean) => {
    if (busy) return;
    const text = draft.trim();
    if (mode === "diagram") {
      if (edits.length === 0) return;
      onSendDiagram(edits, text, queued);
      setEdits([]);
    } else {
      const picture = await sketch.current?.export();
      if (!picture) return;
      onSay(text, [picture, ...uploads.map((upload) => upload.file)], queued);
      uploads.forEach((upload) => URL.revokeObjectURL(upload.preview));
      setUploads([]);
      sketch.current?.clear();
    }
    setDraft("");
    // Back to the timeline, where what was just sent shows up.
    setMode("type");
  };

  const working = agent.status === "working";

  const canSend =
    mode === "type"
      ? draft.trim().length > 0 || uploads.length > 0
      : mode === "diagram"
        ? edits.length > 0
        : sketchReady;

  const send = (queued = agent.status === "working") => {
    if (mode !== "type") {
      void sendDrawn(queued);
      return;
    }
    const text = draft.trim();
    if ((!text && uploads.length === 0) || busy) return;
    // What you just said is what you want to see, wherever you had scrolled
    // to before saying it.
    following.current = true;
    setDraft("");
    onSay(text, uploads.map((upload) => upload.file), queued);
    uploads.forEach((upload) => URL.revokeObjectURL(upload.preview));
    setUploads([]);
    setAttachmentError("");
  };

  /// The same thing you would have said, kept as work to do instead.
  /// The same thing you would have said, kept as work instead -- including
  /// a drawing, which until now only existed at the moment it was sent.
  const toTask = async () => {
    if (busy) return;
    const text = draft.trim();
    const drawn = mode === "draw" ? await sketch.current?.export() : null;
    const pictures = [...(drawn ? [drawn] : []), ...uploads.map((upload) => upload.file)];
    if (!text && pictures.length === 0) return;
    setDraft("");
    onTask(text, pictures);
    uploads.forEach((upload) => URL.revokeObjectURL(upload.preview));
    setUploads([]);
    setAttachmentError("");
    if (drawn) {
      sketch.current?.clear();
      setMode("type");
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
    <section
      className="flex min-w-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
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
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDraggingImages(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {/* One row, whatever the width: what cannot fit is cut, not wrapped,
          because a header that grows downwards takes the conversation's
          space to say what it already said. */}
      <div className="flex h-[var(--bar)] shrink-0 items-center gap-x-[10px] overflow-hidden border-b border-rule pl-3">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer text-[13px] text-mid hover:text-ink"
          aria-label="back to the fleet"
          title="Back to fleet"
        >
          <Icon name="back" />
        </button>
        <span
          className={`h-2 w-2 rounded-full ${
            agent.status === "working"
              ? "bg-ok"
              : agent.status === "stalled"
                ? "bg-hold"
                : "bg-[#c9c1b5]"
          }`}
        />
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
            className="max-w-[40%] shrink-0 cursor-text truncate text-[16px] font-semibold hover:underline"
            title="rename"
          >
            {agent.name}
          </button>
        )}
        {/* It gives up its width first, but never all of it: what an agent
            is doing now is the thing this line is for. */}
        <span className="min-w-[86px] flex-1 truncate text-[12.5px] text-faint">
          {agent.status} {since(agent.updatedAt)} · {agent.backend} · {agent.model} ·{" "}
          {view.delivery}
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
        <SplitAction
          label={can.fork ? "Fork in conversation" : `${agent.backend} cannot fork a session`}
          icon="fork"
          onClick={onForkLocal}
          disabled={busy || !can.fork}
          menu={[
            { label: "Fork to Slack thread", icon: "thread", onClick: onForkSlack },
            { label: "Open another beside this", icon: "split", onClick: onOpenBeside },
          ]}
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
        hidden={mode !== "type"}
        onContextMenu={(event) => {
          const selection = window.getSelection();
          const text = selection?.toString().trim() ?? "";
          const selectedNode = selection?.rangeCount
            ? selection.getRangeAt(0).commonAncestorContainer
            : null;
          if (!text || !selectedNode || !timeline.current?.contains(selectedNode)) return;
          event.preventDefault();
          setQuoteMenu({ text, x: event.clientX, y: event.clientY });
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          setQuoteMenu(null);
        }}
        data-transcript
        className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-[var(--pane-x)] py-2"
      >
        <div ref={timelineBody}>
          {view.timeline.length === 0 ? (
            <p className="text-[13px] text-faint">Nothing on the timeline yet.</p>
          ) : (
            items.map((item) => {
              if ("tools" in item) {
                const first = item.tools[0];
                return (
                  <details key={`tools-${first.id}`} className="group border-b border-hair py-2">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-[11.5px] text-faint marker:content-none hover:text-mid">
                      <span className="w-[34px] shrink-0 tnum">{minute(first.at)}</span>
                      <span className="w-2 text-center group-open:rotate-90">›</span>
                      <span>
                        {item.tools.length} tool {item.tools.length === 1 ? "call" : "calls"}
                      </span>
                    </summary>
                    <div className="ml-[52px] mt-1 flex flex-col">
                      {item.tools.map((entry) => (
                        <div
                          key={entry.id}
                          className="border-t border-hair py-[7px] text-[11.5px] leading-[1.45] text-mid"
                        >
                          {entry.text !== "Command" && (
                            <span className="mr-2 text-faint">{entry.text}</span>
                          )}
                          <div className="break-words whitespace-pre-wrap">
                            {entry.detail || entry.text}
                          </div>
                          {entry.output && (
                            <pre className="quiet-scroll mt-2 max-h-64 overflow-auto bg-band p-2 font-mono text-[11px] leading-[1.4] text-ink whitespace-pre-wrap">
                              {entry.output}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              }

              const { entry } = item;
              return (
                <Message
                  key={entry.id}
                  entry={entry}
                  focused={entry.id === focusEntry}
                  asked={asked}
                  onJump={jumpTo}
                  onOpenAgent={onOpenAgent}
                />
              );
            })
          )}
        </div>
      </div>

      {quoteMenu && (
        <button
          type="button"
          autoFocus
          onBlur={() => setQuoteMenu(null)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={quoteSelection}
          aria-label="quote reply"
          title="Quote reply"
          style={{ left: quoteMenu.x, top: quoteMenu.y }}
          className="fixed z-40 flex h-9 w-9 cursor-pointer items-center justify-center border border-edge bg-card text-ink shadow-[0_8px_24px_rgba(33,29,25,0.16)] hover:bg-wash"
        >
          <Icon name="quote" />
        </button>
      )}

      <footer
        className={`flex shrink-0 flex-col border-t ${
          draggingImages ? "border-drop bg-wash" : "border-rule bg-card"
        }`}
      >
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
        {draggingImages && (
          <p className="px-[var(--pane-x)] pt-[6px] text-[11px] text-drop">Drop images to attach</p>
        )}
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 px-[var(--pane-x)] pt-[6px]">
            {uploads.map((upload) => (
              <span key={upload.preview} className="flex items-center gap-2 bg-band p-2 text-[11px] text-mid">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={upload.preview} alt="" className="h-10 w-10 object-cover" />
                <span className="max-w-48 truncate">{upload.file.name}</span>
                <button
                  type="button"
                  aria-label={`remove ${upload.file.name}`}
                  title={`Remove ${upload.file.name}`}
                  onClick={() => {
                    URL.revokeObjectURL(upload.preview);
                    setUploads((current) => current.filter((item) => item !== upload));
                  }}
                  className="cursor-pointer px-1 text-faint hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && (
          <p className="px-[var(--pane-x)] pt-[6px] text-[11px] text-hold">{attachmentError}</p>
        )}
        <div className="flex items-stretch">
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <SplitAction
            label="Attach images"
            icon="attach"
            onClick={() => picker.current?.click()}
            disabled={busy}
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
                addFiles(files);
              }
            }}
            onKeyDown={(event) => {
              // Enter sends; a newline needs a modifier. This is a chat box,
              // and the common case is one line.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
              // Tab files it instead: the same words, kept as work rather
              // than said now. There is nothing to tab to from here.
              if (event.key === "Tab" && !event.shiftKey && mode !== "diagram") {
                event.preventDefault();
                void toTask();
              }
            }}
            rows={1}
            data-composer
            placeholder={PLACEHOLDER[mode]}
            className="min-h-[var(--cell)] flex-1 resize-none overflow-y-hidden border-x border-rule bg-paper px-3 py-[8px] text-[var(--said)] leading-[1.35] outline-none placeholder:text-faint"
          />
          {mode === "type" ? (
            // One button, one arrow, whether the agent is busy or not. What
            // changes is when it is picked up, which the agent's own state
            // already says; a button that redraws itself underneath you
            // reads as a different button.
            <SplitAction
              label="Send message"
              hint={
                working
                  ? can.steer
                    ? "The agent is working, so this waits its turn"
                    : "The agent is working; it will read this when the turn ends"
                  : "Send message"
              }
              icon="send"
              onClick={() => send(working)}
              disabled={busy || !canSend}
              menu={[
                // Only where it means something: a harness that cannot take
                // input mid-turn makes "now" and "next" the same thing.
                ...(working && can.steer
                  ? [{ label: "Send now, into the turn", icon: "queue" as const, onClick: () => send(false) }]
                  : []),
                { label: "Add to the task list", icon: "tasks" as const, onClick: () => void toTask() },
              ]}
              up
            />
          ) : (
            // A drawing is made at the moment it is sent, so there is
            // nothing yet to put on the task list -- but it waits its turn
            // like anything else said to a working agent.
            <SplitAction
              label={mode === "diagram" ? "Send the change" : "Send the picture"}
              hint={
                working
                  ? "The agent is working, so this waits its turn"
                  : mode === "diagram"
                    ? "Send the change"
                    : "Send the picture"
              }
              icon="send"
              onClick={() => send(working)}
              disabled={busy || !canSend}
              menu={[
                ...(working && can.steer
                  ? [
                      {
                        label: "Send now, into the turn",
                        icon: "queue" as const,
                        onClick: () => send(false),
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
  );
}

/**
 * Something you sent. A drawn diagram change shows as the diagram, and a
 * picture as the picture, with the words the agent got one click away.
 */
/// Anything anyone said: the words, and whatever came with them.
function Said({ text }: { text: string }) {
  if (text.includes("```mermaid")) return <DiagramMessage text={text} />;
  const { body, names } = splitAttached(text);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {body.trim() && <Markdown>{body}</Markdown>}
      {names.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {names.map((name) => (
            <AttachedImage key={name} name={name} />
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
            mine ? "group -mx-7 bg-mine px-7" : "",
            focused ? "bg-band" : "",
          ].join(" ")}
        >
          <span className="tnum w-[34px] shrink-0 pt-[3px] text-[10.5px] text-faint">
            {minute(entry.at)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <div className="flex min-w-0 items-start gap-2 text-[var(--said)] leading-[1.55] break-words">
              {tag && (
                <span className={`shrink-0 pt-[2px] text-[10.5px] ${tag.tone}`}>
                  {tag.label}
                </span>
              )}
              <Said text={entry.text} />
            </div>
            {entry.origin && <span className="text-[11px] text-ok">← {entry.origin}</span>}
            {(["forked", "forkedFrom", "merged", "mergedInto"] as EntryKind[]).includes(entry.kind) && entry.detail ? (
              <button
                type="button"
                onClick={() => onOpenAgent(entry.detail)}
                aria-label={entry.kind === "forked" || entry.kind === "merged" ? "open child session" : "open parent session"}
                title={entry.kind === "forked" || entry.kind === "merged" ? "Open child session" : "Open parent session"}
                className="flex h-6 w-6 cursor-pointer items-center justify-center text-merge"
              >
                <Icon name="open" size={13} />
              </button>
            ) : entry.detail ? (
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

function AttachedImage({ name }: { name: string }) {
  const [missing, setMissing] = useState(false);
  const url = `/api/attachments/${encodeURIComponent(name)}`;
  if (missing) return <span className="text-[12px] text-faint">{name}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" title={name}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name}
        onError={() => setMissing(true)}
        className="max-h-64 max-w-[min(520px,100%)] rounded-[3px] border border-rule"
      />
    </a>
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
