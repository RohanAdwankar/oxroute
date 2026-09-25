"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { clock, since } from "../lib/format";
import type { AgentView, Entry, EntryKind } from "../lib/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { SplitAction } from "./SplitAction";

const TAG: Partial<Record<EntryKind, { label: string; tone: string }>> = {
  received: { label: "you", tone: "text-ok" },
  asked: { label: "asked", tone: "text-hold border-hold" },
  you: { label: "you", tone: "text-merge" },
  forked: { label: "forked", tone: "text-merge border-merge" },
  forkedFrom: { label: "parent", tone: "text-merge border-merge" },
  merged: { label: "merged", tone: "text-merge border-merge" },
  mergedInto: { label: "merged", tone: "text-merge border-merge" },
  notice: { label: "note", tone: "text-faint" },
};

type TimelineItem = { entry: Entry } | { tools: Entry[] };
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
  onBack,
  onSay,
  onInterrupt,
  onForkSlack,
  onForkLocal,
  onMerge,
  onOpenAgent,
  onRename,
  archived,
  onArchive,
  busy,
  focusEntry,
}: {
  view: AgentView;
  onBack: () => void;
  onSay: (text: string, images: File[]) => void;
  onInterrupt: () => void;
  onForkSlack: () => void;
  onForkLocal: () => void;
  onMerge: (() => void) | null;
  onOpenAgent: (id: string) => void;
  onRename: (name: string) => void;
  archived: boolean;
  onArchive: (archived: boolean) => void;
  busy: boolean;
  focusEntry: number | null;
}) {
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [draggingImages, setDraggingImages] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [quoteMenu, setQuoteMenu] = useState<QuoteMenu | null>(null);
  const { agent } = view;
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previousAgent = useRef(agent.id);
  const picker = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const uploadsRef = useRef<Upload[]>([]);
  const renameCancelled = useRef(false);
  const items = compactTimeline(view.timeline);

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
    input.style.height = `${Math.max(42, Math.min(input.scrollHeight, 160))}px`;
    input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => () => {
    uploadsRef.current.forEach((upload) => URL.revokeObjectURL(upload.preview));
  }, []);

  const send = (queued = agent.status === "working") => {
    const text = draft.trim();
    if ((!text && uploads.length === 0) || busy) return;
    setDraft("");
    onSay(queued ? `& ${text}`.trimEnd() : text, uploads.map((upload) => upload.file));
    uploads.forEach((upload) => URL.revokeObjectURL(upload.preview));
    setUploads([]);
    setAttachmentError("");
  };

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
      <div className="flex min-h-[63px] shrink-0 flex-wrap items-center gap-x-[14px] gap-y-1 border-b border-rule px-5 py-2">
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
              ? "bg-ok pulse"
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
            className="cursor-text text-[16px] font-semibold hover:underline"
            title="rename"
          >
            {agent.name}
          </button>
        )}
        <span className="min-w-0 truncate text-[12.5px] text-faint">
          {agent.status} {since(agent.updatedAt)} · {agent.backend} · {agent.model} ·{" "}
          {view.delivery}
        </span>

        <span className="flex-1" />

        {agent.permalink && (
          <a
            href={agent.permalink}
            target="_blank"
            rel="noreferrer"
            aria-label="open in Slack"
            title="Open in Slack"
            className="flex h-8 w-8 items-center justify-center rounded-[3px] border border-rule text-mid hover:text-ink"
          >
            <Icon name="external" />
          </a>
        )}
        <button
          type="button"
          onClick={() => onArchive(!archived)}
          disabled={busy || (!archived && agent.status === "working")}
          aria-label={archived ? "restore session" : "archive session"}
          title={!archived && agent.status === "working" ? "Stop the active turn first" : archived ? "Restore session" : "Archive session"}
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name={archived ? "restore" : "archive"} />
        </button>
        <SplitAction
          label={agent.backend === "codex" ? "Fork in conversation" : "Only Codex can fork"}
          icon="fork"
          onClick={onForkLocal}
          disabled={busy || agent.backend !== "codex"}
          menu={[{ label: "Fork to Slack thread", icon: "thread", onClick: onForkSlack }]}
        />
        {onMerge && (
          <button
            type="button"
            onClick={onMerge}
            disabled={busy || agent.status === "working"}
            aria-label="merge into parent"
            title={agent.status === "working" ? "Stop the active turn first" : "Merge into parent"}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] border border-merge text-merge hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="merge" />
          </button>
        )}
        <button
          type="button"
          onClick={onInterrupt}
          disabled={busy || agent.status !== "working"}
          aria-label="stop the turn"
          title="Stop the turn"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] border border-edge text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="stop" />
        </button>
      </div>

      <div
        ref={timeline}
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
        className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-7 py-2"
      >
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
            const tag = TAG[entry.kind];
            return (
              <div
                key={entry.id}
                data-entry={entry.id}
                className={`flex items-start gap-3 border-b border-hair py-[9px] last:border-b-0 ${entry.id === focusEntry ? "bg-band" : ""}`}
              >
                <span className="tnum w-[34px] shrink-0 pt-[3px] text-[10.5px] text-faint">
                  {minute(entry.at)}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <div className="flex min-w-0 items-start gap-2 text-[16.5px] leading-[1.55] break-words">
                    {tag && (
                      <span className={`shrink-0 pt-[2px] text-[10.5px] ${tag.tone}`}>
                        {tag.label}
                      </span>
                    )}
                    <Markdown>{entry.text}</Markdown>
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
              </div>
            );
          })
        )}
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
        className={`flex shrink-0 flex-col gap-2 border-t px-7 py-4 ${
          draggingImages ? "border-drop bg-wash" : "border-rule bg-card"
        }`}
      >
        {draggingImages && <p className="text-[11px] text-drop">Drop images to attach</p>}
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2">
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
        {attachmentError && <p className="text-[11px] text-hold">{attachmentError}</p>}
        <div className="flex items-end gap-3">
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
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={busy}
            aria-label="attach images"
            title="attach images"
            className="flex h-[42px] w-[34px] cursor-pointer items-center justify-center text-mid hover:text-ink disabled:opacity-40"
          >
            <Icon name="attach" />
          </button>
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
            }}
            rows={1}
            data-composer
            placeholder="Message"
            className="min-h-[42px] flex-1 resize-none overflow-y-hidden rounded-[3px] border border-rule bg-paper px-3 py-[10px] text-[15.5px] outline-none placeholder:text-faint focus:border-edge"
          />
          {agent.status === "working" ? (
            <SplitAction
              label="Queue message"
              icon="queue"
              onClick={() => send(true)}
              disabled={busy || (draft.trim().length === 0 && uploads.length === 0)}
              menu={[{ label: "Send now", icon: "send", onClick: () => send(false) }]}
              variant="composer"
            />
          ) : (
            <button
              type="button"
              onClick={() => send(false)}
              disabled={busy || (draft.trim().length === 0 && uploads.length === 0)}
              aria-label="send message"
              title="Send message"
              className="flex h-[42px] w-[42px] cursor-pointer items-center justify-center rounded-[3px] bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="send" />
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
