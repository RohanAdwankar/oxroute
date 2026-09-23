"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { clip, clock } from "../lib/format";
import type { Agent, InboxItem } from "../lib/types";

/**
 * The sidebar, and the whole point of the interface.
 *
 * Two groups: what is waiting on a decision, and what has already been
 * settled. An item is one decision, so the list never grows a second kind of
 * control -- you open it, and the main column asks where it goes.
 */
export function Inbox({
  items,
  agents,
  selected,
  onSelect,
  onNote,
  busy,
  cursor,
  active,
  composeRef,
  onCollapse,
}: {
  items: InboxItem[];
  agents: Agent[];
  selected: string | null;
  onSelect: (item: InboxItem) => void;
  onNote: (text: string) => void;
  busy: boolean;
  /// Which row the keyboard is on, as an index into `items`.
  cursor: number;
  /// True when the keyboard is driving this column.
  active: boolean;
  /// So a shortcut elsewhere can put the caret in the compose box.
  composeRef: RefObject<HTMLTextAreaElement | null>;
  onCollapse: () => void;
}) {
  const waiting = items.filter((item) => item.state === "waiting");
  const done = items.filter((item) => item.state !== "waiting");
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "an agent";
  const at = items[cursor]?.signal.id ?? null;

  return (
    <aside className="flex h-full w-full flex-col bg-card">
      <div className="flex h-[63px] shrink-0 items-center border-b border-rule px-[18px]">
        <span className="text-[14px] font-semibold">Inbox</span>
        <span className="flex-1" />
        <span className="text-[11.5px] text-faint">
          {waiting.length === 0 ? "all clear" : `${waiting.length} waiting`}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="collapse inbox"
          title="collapse inbox"
          className="ml-3 cursor-pointer text-[18px] leading-none text-faint hover:text-ink"
        >
          ‹
        </button>
      </div>

      <Compose onNote={onNote} busy={busy} inputRef={composeRef} />

      <div className="quiet-scroll flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="px-[18px] py-6 text-[11.5px] text-faint">
            Nothing has arrived yet. Send yourself a Slack message.
          </p>
        )}

        {waiting.length > 0 && <Band label="Waiting on you" strong />}
        {waiting.map((item) => (
          <Row
            key={item.signal.id}
            item={item}
            selected={selected === item.signal.id}
            focused={active && at === item.signal.id}
            onSelect={onSelect}
            name={name}
          />
        ))}

        {done.length > 0 && <Band label="Done" />}
        {done.map((item) => (
          <Row
            key={item.signal.id}
            item={item}
            selected={selected === item.signal.id}
            focused={active && at === item.signal.id}
            onSelect={onSelect}
            name={name}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * Something you thought of, typed straight in.
 *
 * It becomes an ordinary signal and queues with everything else, so an idea
 * of your own gets routed by exactly the same decision as a Slack message --
 * which is the point. There is no separate "new task" flow to maintain.
 */
function Compose({
  onNote,
  busy,
  inputRef,
}: {
  onNote: (text: string) => void;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [draft, setDraft] = useState("");

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onNote(text);
  };

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-rule px-[18px] py-3">
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
        rows={1}
        placeholder="Something you thought of…"
        className="max-h-24 min-h-[34px] flex-1 resize-y rounded-[3px] border border-rule bg-paper px-[9px] py-[7px] text-[11.5px] outline-none placeholder:text-faint focus:border-edge"
      />
      <button
        type="button"
        onClick={send}
        disabled={busy || draft.trim().length === 0}
        aria-label="add to the inbox"
        className="tnum cursor-pointer rounded-[3px] border border-edge px-[11px] py-[7px] text-[12px] text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add
      </button>
    </div>
  );
}

function Band({ label, strong }: { label: string; strong?: boolean }) {
  return (
    <div className="border-y border-rule bg-band px-[18px] py-2 first:border-t-0">
      <span className={`text-[11px] ${strong ? "text-ink" : "text-faint"}`}>{label}</span>
    </div>
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
      : "not routed yet"
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
        <span className="tnum text-[9.5px] text-faint">{clock(signal.at)}</span>
        <span className="tnum rounded-[2px] border border-rule px-[5px] text-[9.5px] text-mid">
          {signal.source}
        </span>
        {signal.label && (
          <span className="tnum truncate text-[9.5px] text-faint">{signal.label}</span>
        )}
      </span>

      <span className={`text-[11.5px] leading-[1.4] ${waiting ? "text-ink" : "text-faint"}`}>
        {signal.text ? clip(signal.text, 130) : `${signal.attachments.length} attachment(s)`}
      </span>

      <span className={`tnum text-[10px] ${footerTone}`}>{footer}</span>
    </button>
  );
}
