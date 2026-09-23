"use client";

import type { Mode, Snapshot } from "../lib/types";
import { Search } from "./Search";

/**
 * The top bar: the wordmark, the one global switch, and the counters.
 *
 * The mode switch is the only setting in the interface, and it is up here
 * because it changes what happens to everything that arrives next.
 */
export function Chrome({
  snapshot,
  notice,
  onMode,
  vim,
  onVim,
  onSearchOpen,
  onSearchContinue,
}: {
  snapshot: Snapshot;
  notice: string | null;
  onMode: (mode: Mode) => void;
  vim: boolean;
  onVim: () => void;
  onSearchOpen: (agent: string, entry: number) => void;
  onSearchContinue: (agent: string) => void;
}) {
  return (
    <header className="flex min-h-[63px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-card px-5 py-2">
      <div className="flex" role="group" aria-label="routing mode">
        <ModeButton
          label="Ask me first"
          active={snapshot.mode === "ask"}
          side="left"
          onClick={() => onMode("ask")}
        />
        <ModeButton
          label="Auto route"
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

      <Search onOpen={onSearchOpen} onContinue={onSearchContinue} />

      <div className="flex-1" />

      {notice && (
        <span className="min-w-0 flex-1 basis-[180px] truncate text-[12.5px] text-merge" role="status">
          {notice}
        </span>
      )}
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
        "tnum cursor-pointer whitespace-nowrap px-[15px] py-[6px] text-[12px] transition-colors",
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
