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
  tasksOpen,
  onTasks,
  onSettings,
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
  tasksOpen: boolean;
  onTasks: () => void;
  onSettings: () => void;
  activeBoard: string | null;
  onBoard: (id: string | null) => void;
  onNewBoard: () => void;
  onSearchOpen: (agent: string, entry: number) => void;
  onSearchContinue: (agent: string) => void;
}) {
  return (
    <header className="flex min-h-[var(--bar)] shrink-0 flex-wrap items-stretch border-b border-rule bg-card">
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
      <Cell onClick={onTasks} pressed={tasksOpen} label="Show or hide tasks" icon="tasks" />
      <Cell onClick={onSettings} label="Settings" icon="settings" />

      <nav className="flex items-stretch" aria-label="boards">
        <Cell
          onClick={() => onBoard(null)}
          pressed={activeBoard === null}
          label="Show the fleet"
          icon="terminal"
        />
        {snapshot.boards.map((board) => (
          <Cell
            key={board.id}
            onClick={() => onBoard(board.id)}
            pressed={activeBoard === board.id}
            label={`Show ${board.name}`}
            icon="board"
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
        "flex h-[var(--cell)] w-[var(--cell)] cursor-pointer items-center justify-center border-r border-rule transition-colors",
        pressed ? "bg-wash text-ink" : "text-faint hover:text-ink",
      ].join(" ")}
    >
      <Icon name={icon} size={14} />
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
        "flex h-[var(--cell)] w-[var(--cell)] cursor-pointer items-center justify-center border-r border-rule transition-colors",
        active ? "bg-wash text-ink" : "text-faint hover:text-ink",
      ].join(" ")}
    >
      <Icon name={icon} />
    </button>
  );
}
