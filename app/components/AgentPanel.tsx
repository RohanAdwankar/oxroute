"use client";

import { useEffect, useRef, useState } from "react";

import { clock, since } from "../lib/format";
import type { AgentView, Entry, EntryKind } from "../lib/types";
import { Markdown } from "./Markdown";

const TAG: Partial<Record<EntryKind, { label: string; tone: string }>> = {
  received: { label: "you", tone: "text-ok" },
  asked: { label: "asked", tone: "text-hold border-hold" },
  you: { label: "you", tone: "text-merge" },
  forked: { label: "forked", tone: "text-merge border-merge" },
  forkedFrom: { label: "parent", tone: "text-merge border-merge" },
  notice: { label: "note", tone: "text-faint" },
};

type TimelineItem = { entry: Entry } | { tools: Entry[] };

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
  onFork,
  onOpenAgent,
  onRename,
  busy,
  focusEntry,
}: {
  view: AgentView;
  onBack: () => void;
  onSay: (text: string) => void;
  onInterrupt: () => void;
  onFork: () => void;
  onOpenAgent: (id: string) => void;
  onRename: (name: string) => void;
  busy: boolean;
  focusEntry: number | null;
}) {
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const renameCancelled = useRef(false);
  const { agent } = view;
  const items = compactTimeline(view.timeline);

  // Follow the tail as work arrives, which is what you want while watching,
  // and re-pin whenever you switch agents.
  useEffect(() => {
    const target = focusEntry
      ? timeline.current?.querySelector<HTMLElement>(`[data-entry="${focusEntry}"]`)
      : null;
    if (target) target.scrollIntoView({ block: "center" });
    else timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [view.timeline.length, agent.id, focusEntry]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSay(text);
  };

  const finishRename = () => {
    const name = nameDraft.trim();
    setRenaming(false);
    if (name && name !== agent.name) onRename(name);
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-[63px] shrink-0 items-center gap-[14px] border-b border-rule px-7">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer text-[13px] text-mid hover:text-ink"
          aria-label="back to the fleet"
        >
          ←
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
            className="cursor-text text-[15px] font-semibold hover:underline"
            title="rename"
          >
            {agent.name}
          </button>
        )}
        <span className="text-[12.5px] text-faint">
          {agent.status} {since(agent.updatedAt)} · {agent.backend} · {agent.model} ·{" "}
          {view.delivery}
        </span>

        <span className="flex-1" />

        {agent.permalink && (
          <a
            href={agent.permalink}
            target="_blank"
            rel="noreferrer"
            className="tnum rounded-[3px] border border-rule px-[13px] py-[7px] text-[12px] text-mid hover:text-ink"
          >
            Open in Slack
          </a>
        )}
        <button
          type="button"
          onClick={onFork}
          disabled={busy || agent.backend !== "codex"}
          title={agent.backend === "codex" ? "branch this history" : "only Codex can fork"}
          className="tnum cursor-pointer rounded-[3px] border border-rule px-[13px] py-[7px] text-[12px] text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Fork
        </button>
        <button
          type="button"
          onClick={onInterrupt}
          disabled={busy || agent.status !== "working"}
          className="tnum cursor-pointer rounded-[3px] border border-edge px-[13px] py-[7px] text-[12px] text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Stop the turn
        </button>
      </div>

      <div ref={timeline} className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-7 py-2">
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
                  <div className="flex min-w-0 items-start gap-2 text-[15px] leading-[1.5] break-words">
                    {tag && (
                      <span className={`shrink-0 pt-[2px] text-[10.5px] ${tag.tone}`}>
                        {tag.label}
                      </span>
                    )}
                    <Markdown>{entry.text}</Markdown>
                  </div>
                  {entry.origin && <span className="text-[11px] text-ok">← {entry.origin}</span>}
                  {(entry.kind === "forked" || entry.kind === "forkedFrom") && entry.detail ? (
                    <button
                      type="button"
                      onClick={() => onOpenAgent(entry.detail)}
                      className="w-fit cursor-pointer text-[11px] text-merge hover:underline"
                    >
                      {entry.kind === "forked" ? "Open forked session →" : "Open parent session ↑"}
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

      <footer className="flex shrink-0 items-end gap-3 border-t border-rule bg-card px-7 py-4">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; a newline needs a modifier. This is a chat box,
            // and the common case is one line.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={
            view.delivery === "steer"
              ? "Say something — it folds into the turn it is running"
              : view.delivery === "queue"
                ? "Say something — it waits for the current turn to end"
                : "Say something — it starts a new turn"
          }
          className="max-h-32 min-h-[42px] flex-1 resize-y rounded-[3px] border border-rule bg-paper px-3 py-[10px] text-[14.5px] outline-none placeholder:text-faint focus:border-edge"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || draft.trim().length === 0}
          className="cursor-pointer rounded-[3px] bg-ink px-5 py-[11px] text-[14px] font-semibold text-paper disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </footer>
    </section>
  );
}
