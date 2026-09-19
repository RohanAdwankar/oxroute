"use client";

import type { Mode, Snapshot } from "../lib/types";

/**
 * The top bar: the wordmark, the one global switch, and the counters.
 *
 * The mode switch is the only setting in the interface, and it is up here
 * because it changes what happens to everything that arrives next.
 */
export function Chrome({
  snapshot,
  waiting,
  notice,
  onMode,
  vim,
  onVim,
}: {
  snapshot: Snapshot;
  waiting: number;
  notice: string | null;
  onMode: (mode: Mode) => void;
  vim: boolean;
  onVim: () => void;
}) {
  const count = (status: string) =>
    snapshot.agents.filter((agent) => agent.status === status).length;

  return (
    <header className="flex h-[63px] shrink-0 items-center gap-4 border-b border-rule bg-card px-7">
      <span
        className="text-[25px] tracking-[-0.01em]"
        style={{ fontFamily: "var(--font-wordmark)" }}
      >
        oxroute
      </span>

      <div className="flex" role="group" aria-label="routing mode">
        <ModeButton
          label="Ask me first"
          active={snapshot.mode === "ask"}
          side="left"
          onClick={() => onMode("ask")}
        />
        <ModeButton
          label="Route on its own"
          active={snapshot.mode === "auto"}
          side="right"
          onClick={() => onMode("auto")}
        />
      </div>

      <button
        type="button"
        onClick={onVim}
        aria-pressed={vim}
        title="one-key hints on the agent cards (v)"
        className={[
          "tnum cursor-pointer rounded-[3px] border px-[11px] py-[5px] text-[11.5px]",
          vim ? "border-edge bg-wash text-ink" : "border-rule text-faint hover:text-mid",
        ].join(" ")}
      >
        vim
      </button>

      <div className="flex-1" />

      {notice && (
        <span className="max-w-[46ch] truncate text-[12.5px] text-merge" role="status">
          {notice}
        </span>
      )}

      <div className="flex items-center gap-6">
        <Counter value={waiting} label="waiting" tone="text-hold" />
        <Counter value={count("working")} label="working" tone="text-ok" />
        <Counter value={count("stalled")} label="stalled" tone="text-hold" />
        <span className="h-[26px] w-px bg-rule" />
        <Counter value={snapshot.agents.length} label="agents" tone="text-ink" />
      </div>
    </header>
  );
}

function ModeButton({
  label,
  active,
  side,
  onClick,
}: {
  label: string;
  active: boolean;
  side: "left" | "right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "tnum cursor-pointer px-[15px] py-[6px] text-[12px] transition-colors",
        side === "left" ? "rounded-l-[3px] border" : "rounded-r-[3px] border border-l-0",
        active
          ? "border-edge bg-wash text-ink"
          : "border-rule bg-transparent text-mid hover:text-ink",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function Counter({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <span className="flex flex-col items-end leading-tight">
      <span className={`tnum text-[15px] ${tone}`}>{value}</span>
      <span className="text-[9.5px] text-faint uppercase tracking-wide">{label}</span>
    </span>
  );
}
