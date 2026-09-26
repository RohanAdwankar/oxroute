"use client";

import { useState } from "react";

import { clip, since } from "../lib/format";
import { hintFor } from "../lib/keys";
import { Icon } from "./Icon";
import { TagChip } from "./Tags";
import {
  deliveryOf,
  type Agent,
  type Delivery,
  type InboxItem,
  type ModelInfo,
} from "../lib/types";

const DOT: Record<string, string> = {
  working: "bg-ok",
  stalled: "bg-hold",
  complete: "bg-[#c9c1b5]",
};

const DELIVERY_NOTE: Record<Delivery, string> = {
  steer: "folds into the turn it is running",
  queue: "waits for the current turn to end",
  start: "this is what sets it going",
};

/**
 * The main column.
 *
 * With nothing selected it is the fleet. With a signal selected it is the
 * same fleet with ticks, because "which agents does this go to" and "what is
 * running" are the same question asked twice.
 */
export function Fleet({
  agents,
  archivedCount,
  showArchived,
  onShowArchived,
  models,
  defaultModel,
  messages,
  tags,
  routing,
  beside,
  ticked,
  onToggle,
  onOpen,
  onPin,
  onSend,
  onSpawn,
  onDiscard,
  busy,
  cursor,
  active,
  vim,
}: {
  agents: Agent[];
  archivedCount: number;
  showArchived: boolean;
  onShowArchived: () => void;
  models: ModelInfo[];
  defaultModel: string;
  messages: Record<string, string>;
  tags: Record<string, string[]>;
  routing: InboxItem | null;
  /// The name of the session a companion is being picked for, if one is.
  beside: string | null;
  ticked: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onSend: () => void;
  onSpawn: (model: string) => void;
  onDiscard: () => void;
  busy: boolean;
  /// Which card the keyboard is on.
  cursor: number;
  /// True when the keyboard is driving this column.
  active: boolean;
  /// Show the one-key hints. Off means the mouse is doing the work.
  vim: boolean;
}) {
  // Which model a new agent gets. It also picks the harness, since a model
  // belongs to exactly one.
  const [model, setModel] = useState("");
  const chosen = model || defaultModel || models[0]?.id || "";
  const shown = agents;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-[var(--bar)] shrink-0 items-center gap-3 border-b border-rule px-[var(--pane-x)]">
        {beside ? (
          <>
            <span className="shrink-0 text-[12px] text-faint">Open beside</span>
            <span className="truncate text-[14px]">{beside}</span>
          </>
        ) : routing ? (
          <>
            <span className="shrink-0 text-[12px] text-faint">Send this to</span>
            <span className="truncate text-[14px]">
              {routing.signal.text
                ? `“${clip(routing.signal.text, 120)}”`
                : `${routing.signal.attachments.length} attachment(s)`}
            </span>
          </>
        ) : (
          <>
            <span className="text-[15px] font-semibold">{showArchived ? "Archived" : "Fleet"}</span>
            <span className="text-[12.5px] text-faint">
              {shown.length === 0
                ? showArchived ? "empty" : "nothing running"
                : `${shown.length} agent${shown.length === 1 ? "" : "s"}`}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={onShowArchived}
              aria-label={showArchived ? "back to fleet" : `show ${archivedCount} archived sessions`}
              title={showArchived ? "Back to fleet" : `Archived sessions (${archivedCount})`}
              className="flex h-8 w-8 cursor-pointer items-center justify-center text-mid hover:text-ink"
            >
              <Icon name={showArchived ? "back" : "archive"} />
            </button>
          </>
        )}
      </div>

      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-7 py-[26px]">
        {shown.length === 0 ? (
          <p className="max-w-[46ch] text-[13px] leading-relaxed text-faint">
            {showArchived
              ? "No archived sessions."
              : "No agents yet. Message the Slack app, or pick something in the inbox and start an agent for it."}
          </p>
        ) : (
          <div
            className="grid content-start gap-5"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 334px), 1fr))",
            }}
          >
            {shown.map((agent, index) => (
              <Card
                key={agent.id}
                agent={agent}
                preview={messages[agent.id]}
                tags={tags[agent.id] ?? []}
                routing={routing !== null}
                ticked={ticked.has(agent.id)}
                suggested={routing?.suggested === agent.id}
                focused={active && index === cursor}
                hint={vim ? hintFor(index) : null}
                onToggle={() => onToggle(agent.id)}
                onOpen={() => onOpen(agent.id)}
                onPin={() => onPin(agent.id, !agent.pinned)}
              />
            ))}
          </div>
        )}
      </div>

      {routing && (
        <footer className="flex shrink-0 items-center gap-3 border-t border-rule bg-card px-7 py-4">
          <button
            type="button"
            disabled={busy || ticked.size === 0}
            onClick={onSend}
            aria-label={ticked.size === 0 ? "pick an agent" : `send to ${ticked.size} agent${ticked.size === 1 ? "" : "s"}`}
            title={ticked.size === 0 ? "Pick an agent" : `Send to ${ticked.size} agent${ticked.size === 1 ? "" : "s"}`}
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="send" />
          </button>
          <span className="flex items-stretch">
            <button
              type="button"
              disabled={busy || !chosen}
              onClick={() => onSpawn(chosen)}
              aria-label="start a new agent"
              title="Start a new agent"
              className="relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-l-[3px] border border-edge text-ink disabled:opacity-40"
            >
              {vim && <Hint at="n" />}
              <Icon name="plus" />
            </button>
            <select
              value={chosen}
              onChange={(event) => setModel(event.target.value)}
              disabled={busy}
              aria-label="model for the new agent"
              className="tnum cursor-pointer rounded-r-[3px] border border-l-0 border-edge bg-wash px-3 text-[12.5px] text-ink outline-none disabled:opacity-40"
            >
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.backend}
                </option>
              ))}
            </select>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={onDiscard}
            aria-label="discard"
            title="Discard"
            className="relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-[3px] border border-rule text-mid hover:text-ink disabled:opacity-40"
          >
            {vim && <Hint at="d" />}
            <Icon name="discard" />
          </button>
        </footer>
      )}
    </section>
  );
}

/** The letter that does this, in the same badge wherever it appears. */
function Hint({ at }: { at: string }) {
  return (
    <span
      aria-hidden
      className="tnum absolute -top-2 -left-2 flex h-[22px] min-w-[22px] items-center justify-center rounded-[3px] bg-ink px-1 text-[12px] font-semibold text-paper"
    >
      {at}
    </span>
  );
}

function Card({
  agent,
  preview,
  tags,
  routing,
  ticked,
  suggested,
  focused,
  hint,
  onToggle,
  onOpen,
  onPin,
}: {
  agent: Agent;
  preview?: string;
  tags: string[];
  routing: boolean;
  ticked: boolean;
  suggested: boolean;
  focused: boolean;
  hint: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onPin: () => void;
}) {
  const delivery = deliveryOf(agent);
  // While routing, the agents this could go to stay bright and the rest
  // recede, so a large fleet is still readable at a glance.
  const dimmed = routing && !ticked && !suggested;

  return (
    <article
      className={[
        "group relative flex h-[212px] w-full flex-col rounded-[3px] bg-card px-[19px] py-[17px] transition-opacity",
        ticked ? "border-2 border-ink" : "border border-rule",
        // The cursor is a ring rather than a fill, so it reads on top of the
        // tick state instead of fighting it.
        focused ? "ring-2 ring-ink ring-offset-2 ring-offset-paper" : "",
        dimmed ? "opacity-[0.42]" : "opacity-100",
      ].join(" ")}
    >
      {hint && <Hint at={hint} />}
      <div className="flex items-center gap-[10px]">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${DOT[agent.status] ?? DOT.complete}`}
        />
        <button
          type="button"
          onClick={onOpen}
          title={`Open ${agent.name}`}
          className="min-w-0 cursor-pointer truncate text-left text-[14.5px] font-semibold leading-tight hover:underline"
        >
          {agent.name}
        </button>
        <span className="flex-1" />
        {!routing && (
          <button
            type="button"
            onClick={onPin}
            aria-pressed={agent.pinned}
            aria-label={agent.pinned ? `unpin ${agent.name}` : `pin ${agent.name}`}
            title={agent.pinned ? "Unpin" : "Pin"}
            className={`flex h-7 w-7 cursor-pointer items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 ${agent.pinned ? "text-ink" : "text-faint hover:text-mid"}`}
          >
            <Icon name="pin" size={14} />
          </button>
        )}
        {routing && (
          <button
            type="button"
            role="checkbox"
            aria-checked={ticked}
            aria-label={`send to ${agent.name}`}
            title={ticked ? `Do not send to ${agent.name}` : `Send to ${agent.name}`}
            onClick={onToggle}
            className={[
              "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px]",
              ticked ? "bg-ink" : "border-[1.5px] border-edge",
            ].join(" ")}
          >
            {ticked && (
              <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden>
                <path
                  d="M1.5,5.2 L3.9,7.6 L8.5,2.6"
                  fill="none"
                  stroke="#f7f4ef"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        )}
      </div>

      <div className="mt-[6px] ml-[18px] text-[12px] text-faint">
        {agent.status} {since(agent.updatedAt)} · {agent.backend}
      </div>

      {tags.length > 0 && (
        <div className="mt-[8px] ml-[18px] flex max-h-[22px] flex-wrap gap-[4px] overflow-hidden">
          {tags.map((tag) => (
            <TagChip key={tag} tag={tag} quiet />
          ))}
        </div>
      )}

      <p className={`mt-[12px] text-[13px] leading-[1.55] text-mid ${tags.length > 0 ? "line-clamp-3" : "line-clamp-4"}`}>
        {preview || agent.stallReason || agent.model}
      </p>

      <div className="flex-1" />

      <div className="mt-[14px] flex items-baseline border-t border-hair pt-3">
        <span className="text-[12.5px] text-mid">{DELIVERY_NOTE[delivery]}</span>
        <span className="flex-1" />
        <span
          className={`tnum text-[12.5px] ${delivery === "queue" ? "text-hold" : "text-ok"}`}
        >
          {delivery}
        </span>
      </div>
    </article>
  );
}
