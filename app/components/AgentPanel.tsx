"use client";

import { useEffect, useRef, useState } from "react";

import { clock, since } from "../lib/format";
import type { AgentView, EntryKind } from "../lib/types";

const TAG: Record<EntryKind, { label: string; tone: string }> = {
  received: { label: "received", tone: "text-ok border-ok" },
  said: { label: "said", tone: "text-ink border-rule" },
  worked: { label: "worked", tone: "text-mid border-rule" },
  asked: { label: "asked", tone: "text-hold border-hold" },
  you: { label: "you", tone: "text-merge border-merge" },
  forked: { label: "forked", tone: "text-merge border-merge" },
  forkedFrom: { label: "parent", tone: "text-merge border-merge" },
  notice: { label: "note", tone: "text-faint border-rule" },
};

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
}: {
  view: AgentView;
  onBack: () => void;
  onSay: (text: string) => void;
  onInterrupt: () => void;
  onFork: () => void;
  onOpenAgent: (id: string) => void;
  onRename: (name: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const { agent } = view;

  // Follow the tail as work arrives, which is what you want while watching,
  // and re-pin whenever you switch agents.
  useEffect(() => {
    timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [view.timeline.length, agent.id]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSay(text);
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
        <button
          type="button"
          onClick={() => {
            const next = window.prompt("Rename this agent", agent.name);
            if (next && next.trim()) onRename(next.trim());
          }}
          className="cursor-pointer text-[15px] font-semibold hover:underline"
          title="rename"
        >
          {agent.name}
        </button>
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

      {agent.activity && (
        <div className="mx-7 mt-[22px] shrink-0 rounded-[3px] border border-rule border-l-[3px] border-l-ok bg-card px-[18px] py-[15px]">
          <span className="text-[15px] leading-[1.5]">{agent.activity}</span>
        </div>
      )}

      <div ref={timeline} className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-7 py-[18px]">
        {view.timeline.length === 0 ? (
          <p className="text-[13px] text-faint">Nothing on the timeline yet.</p>
        ) : (
          view.timeline.map((entry) => {
            const tag = TAG[entry.kind] ?? TAG.notice;
            return (
              <div
                key={entry.id}
                className="flex items-start gap-4 border-b border-hair py-3 last:border-b-0"
              >
                <span className="tnum w-[62px] shrink-0 pt-[2px] text-[12px] text-faint">
                  {clock(entry.at)}
                </span>
                <span className="w-[84px] shrink-0 pt-[1px]">
                  <span
                    className={`tnum rounded-[2px] border px-[7px] py-px text-[10.5px] ${tag.tone}`}
                  >
                    {tag.label}
                  </span>
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
                  <span className="text-[13.5px] leading-[1.5] whitespace-pre-wrap break-words">
                    {entry.text}
                  </span>
                  {entry.origin && (
                    <span className="text-[12px] text-ok">← {entry.origin}</span>
                  )}
                  {(entry.kind === "forked" || entry.kind === "forkedFrom") && entry.detail ? (
                    <button
                      type="button"
                      onClick={() => onOpenAgent(entry.detail)}
                      className="w-fit cursor-pointer text-[12px] text-merge hover:underline"
                    >
                      {entry.kind === "forked" ? "Open forked session →" : "Open parent session ↑"}
                    </button>
                  ) : entry.detail ? (
                    <span className="text-[12px] text-faint">{entry.detail}</span>
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
          className="max-h-32 min-h-[42px] flex-1 resize-y rounded-[3px] border border-rule bg-paper px-3 py-[10px] text-[13.5px] outline-none placeholder:text-faint focus:border-edge"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || draft.trim().length === 0}
          className="cursor-pointer rounded-[3px] bg-ink px-5 py-[11px] text-[13.5px] font-semibold text-paper disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </footer>
    </section>
  );
}
