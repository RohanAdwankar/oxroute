"use client";

import type { Mode, Snapshot } from "../lib/types";
import { Icon, type IconName } from "./Icon";
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
  inboxOpen,
  onInbox,
  vim,
  onVim,
  tasksOpen,
  onTasks,
  activeBoard,
  onBoard,
  onNewBoard,
  onSearchOpen,
  onSearchContinue,
}: {
  snapshot: Snapshot;
  notice: string | null;
  onMode: (mode: Mode) => void;
  inboxOpen: boolean;
  onInbox: () => void;
  vim: boolean;
  onVim: () => void;
  tasksOpen: boolean;
  onTasks: () => void;
  activeBoard: string | null;
  onBoard: (id: string | null) => void;
  onNewBoard: () => void;
  onSearchOpen: (agent: string, entry: number) => void;
  onSearchContinue: (agent: string) => void;
}) {
  return (
    <header className="flex min-h-[46px] shrink-0 flex-wrap items-stretch border-b border-rule bg-card">
      <div className="flex items-stretch" role="group" aria-label="routing mode">
        <ModeButton
          label="Ask me first"
          icon="ask"
          active={snapshot.mode === "ask"}
          onClick={() => onMode("ask")}
        />
        <ModeButton
          label="Auto route"
          icon="auto"
          active={snapshot.mode === "auto"}
          onClick={() => onMode("auto")}
        />
      </div>

      <Cell
        onClick={onInbox}
        pressed={inboxOpen}
        label="Show or hide the inbox"
        icon="inbox"
      />
      <Cell
        onClick={onVim}
        pressed={vim}
        label="One-key hints on the cards (v)"
        icon="keyboard"
      />
      <Cell onClick={onTasks} pressed={tasksOpen} label="Show or hide tasks" icon="tasks" />

      <nav className="flex items-stretch" aria-label="boards">
        <ViewTab
          label="Fleet"
          icon="terminal"
          active={activeBoard === null}
          onClick={() => onBoard(null)}
        />
        {snapshot.boards.map((board) => (
          <ViewTab
            key={board.id}
            label={board.name}
            icon="board"
            active={activeBoard === board.id}
            onClick={() => onBoard(board.id)}
          />
        ))}
        <Cell onClick={onNewBoard} label="New board" icon="plus" />
      </nav>

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

/**
 * One square in the top bar.
 *
 * The bar is a strip of cells sharing their edges rather than a row of
 * chips on a background: fewer outlines, less air, and nothing to align.
 * Every one says what it does on hover, because an icon alone does not.
 */
function Cell({
  onClick,
  pressed,
  label,
  icon,
}: {
  onClick: () => void;
  pressed?: boolean;
  label: string;
  icon: IconName;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      className={[
        "flex w-[38px] cursor-pointer items-center justify-center border-r border-rule transition-colors",
        pressed ? "bg-wash text-ink" : "text-faint hover:text-ink",
      ].join(" ")}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

/**
 * One entry in the view switch. Views carry names, so these are words; the
 * fleet is the view every install has.
 */
function ViewTab({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`Show ${label}`}
      className={[
        "flex cursor-pointer items-center gap-[6px] border-r border-rule px-[14px] text-[12.5px] transition-colors",
        active ? "bg-wash text-ink" : "text-mid hover:text-ink",
      ].join(" ")}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}

function ModeButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={[
        "flex w-[38px] cursor-pointer items-center justify-center border-r border-rule transition-colors",
        active ? "bg-wash text-ink" : "text-faint hover:text-ink",
      ].join(" ")}
    >
      <Icon name={icon} />
    </button>
  );
}
