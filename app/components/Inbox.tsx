"use client";

import { Fragment, useEffect, useRef } from "react";

import { clip, clock } from "../lib/format";
import type { InboxRow } from "../lib/inbox";
import type { Agent, InboxItem } from "../lib/types";
import { Icon } from "./Icon";

/**
 * The sidebar, and the whole point of the interface.
 *
 * Two groups: what is waiting on a decision, and what has already been
 * settled. An item is one decision, so the list never grows a second kind of
 * control -- you open it, and the main column asks where it goes.
 */
export function Inbox({
  items,
  connectors,
  rows,
  onShowDone,
  agents,
  selected,
  onSelect,
  onClear,
  busy,
  waitingCount,
  cursor,
  active,
  onCollapse,
}: {
  items: InboxItem[];
  connectors?: {source: string; configured: boolean; lastSync: number | null; error: string | null}[];
  /// The column as it is drawn; the cursor counts these.
  rows: InboxRow[];
  onShowDone: () => void;
  agents: Agent[];
  selected: string | null;
  onSelect: (item: InboxItem) => void;
  onClear: () => void;
  waitingCount?: number;
  busy: boolean;
  /// Which row the keyboard is on, as an index into `rows`.
  cursor: number;
  /// True when the keyboard is driving this column.
  active: boolean;
  onCollapse: () => void;
}) {
  const waiting = waitingCount ?? items.filter((item) => item.state === "waiting").length;
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "an agent";

  return (
    <aside className="flex h-full w-full flex-col bg-card">
      <div className="flex h-[var(--bar)] shrink-0 items-center border-b border-rule px-[18px]">
        <span className="text-[14px] font-semibold">Inbox</span>
        <span className="flex-1" />
        <span className="text-[11.5px] text-faint">
          {waiting === 0 ? "all clear" : `${waiting} waiting`}
        </span>
        <button type="button" onClick={onClear} disabled={busy || waiting === 0} aria-label="Clear all inbox arrivals" title="Clear all" className="ml-3 cursor-pointer text-faint hover:text-ink disabled:cursor-default disabled:opacity-30"><Icon name="discard" size={14} /></button>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="collapse inbox"
          title="collapse inbox"
          className="ml-3 cursor-pointer text-[18px] leading-none text-faint hover:text-ink"
        >
          <Icon name="collapse" size={18} />
        </button>
      </div>

      <div className="quiet-scroll flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="px-[18px] py-6 text-[11.5px] text-faint">
            New incoming messages and direct mentions appear here.
          </p>
        )}

        {rows.map((row, index) =>
          row.kind === "band" ? (
            <Band
              key="done"
              label={`Done · ${row.count}`}
              focused={active && index === cursor}
              onClick={onShowDone}
            />
          ) : (
            <Fragment key={`${row.item.signal.id}-${index}`}>
              {index === 0 && <Band label="Waiting on you" strong />}
              <Row
                item={row.item}
                selected={selected === row.item.signal.id}
                focused={active && index === cursor}
                onSelect={onSelect}
                name={name}
              />
            </Fragment>
          ),
        )}
      </div>
      {connectors?.filter(source => source.configured).map(source => <div key={source.source} className="px-[18px] py-1 text-[11px] text-faint" title={source.error ?? "Read-only; waiting for your routing decision"}>
        {source.source === "outlook-inbox" ? "Outlook" : "Slack"} · {source.error ? "sync interrupted" : source.lastSync ? "synced" : "loading"}
      </div>)}
    </aside>
  );
}

function Band({
  label,
  strong,
  focused,
  onClick,
}: {
  label: string;
  strong?: boolean;
  focused?: boolean;
  onClick?: () => void;
}) {
  const skin = `w-full border-y border-rule bg-band px-[18px] py-2 text-left first:border-t-0 ${
    focused ? "border-l-[3px] border-l-ink pl-[15px]" : ""
  }`;
  const text = `text-[11px] ${strong ? "text-ink" : "text-faint"}`;
  if (!onClick) {
    return (
      <div className={skin}>
        <span className={text}>{label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show or hide what is settled"
      className={`${skin} cursor-pointer hover:text-ink`}
    >
      <span className={text}>{label}</span>
    </button>
  );
}

function Row({
  item,
  selected,
  focused,
  onSelect,
  name,
}: {
  item: InboxItem;
  selected: boolean;
  focused: boolean;
  onSelect: (item: InboxItem) => void;
  name: (id: string) => string;
}) {
  const waiting = item.state === "waiting";
  const { signal } = item;
  const row = useRef<HTMLButtonElement>(null);

  // Keep the keyboard cursor on screen; arrowing past the fold and seeing
  // nothing move is the fastest way to lose track of where you are.
  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  // What happened to it, in the same slot whether it is a question or an
  // answer, so the eye lands in one place down the column.
  const footer = waiting
    ? item.suggested
      ? `→ ${name(item.suggested)}`
      : item.recommendation?.action === "spawn" ? "→ New agent" : item.recommendation?.action === "discard" ? "→ Dismiss" : "not routed yet"
    : item.outcome || "done";
  const footerTone = waiting
    ? "text-hold"
    : item.outcome.startsWith("discard")
      ? "text-faint"
      : item.outcome.startsWith("merged")
        ? "text-merge"
        : "text-ok";

  return (
    <button
      ref={row}
      type="button"
      onClick={() => onSelect(item)}
      data-inbox-item
      aria-current={selected || focused}
      className={[
        "flex w-full cursor-pointer flex-col gap-[5px] border-b border-hair border-l-[3px] py-[13px] pr-[18px] pl-[15px] text-left",
        selected
          ? "border-l-ink bg-wash"
          : focused
            ? "border-l-edge bg-wash/60"
            : "border-l-transparent hover:bg-paper",
      ].join(" ")}
    >
      <span className="flex items-center gap-[7px]">
        <time dateTime={new Date(signal.at * 1000).toISOString()} title={new Date(signal.at * 1000).toLocaleString()} className="tnum text-[9.5px] text-faint">{new Date(signal.at * 1000).toDateString() === new Date().toDateString() ? clock(signal.at) : new Date(signal.at * 1000).toLocaleDateString(undefined, {month:"short", day:"numeric"})}</time>
        <span className="tnum rounded-[2px] border border-rule px-[5px] text-[9.5px] text-mid">
          {signal.source === "outlook-inbox" ? "Outlook" : signal.source === "slack-inbox" ? "Slack" : signal.source}
        </span>
        {(item.display?.label ?? signal.label) && (
          <span title={signal.label} className="tnum truncate text-[9.5px] text-faint">{item.display?.label ?? signal.label}</span>
        )}
      </span>

      <span className={`text-[11.5px] leading-[1.4] ${waiting ? "text-ink" : "text-faint"}`}>
        {signal.text ? clip(item.display?.preview ?? signal.text, 130) : `${signal.attachments.length} attachment(s)`}
      </span>

      <span title={waiting ? item.recommendation?.reason : undefined} className={`tnum text-[10px] ${footerTone}`}>{footer}</span>
    </button>
  );
}
