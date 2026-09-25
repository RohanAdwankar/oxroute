"use client";

import type { Mode, Snapshot } from "../lib/types";
import { VIEWS } from "../views/registry";
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
  vim,
  onVim,
  watch,
  onWatch,
  tasksOpen,
  onTasks,
  activeView,
  onView,
  onSearchOpen,
  onSearchContinue,
}: {
  snapshot: Snapshot;
  notice: string | null;
  onMode: (mode: Mode) => void;
  vim: boolean;
  onVim: () => void;
  watch: boolean;
  onWatch: () => void;
  tasksOpen: boolean;
  onTasks: () => void;
  activeView: string | null;
  onView: (id: string | null) => void;
  onSearchOpen: (agent: string, entry: number) => void;
  onSearchContinue: (agent: string) => void;
}) {
  return (
    <header className="flex min-h-[63px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-card px-5 py-2">
      <div className="flex" role="group" aria-label="routing mode">
        <ModeButton
          label="Ask me first"
          icon="ask"
          active={snapshot.mode === "ask"}
          side="left"
          onClick={() => onMode("ask")}
        />
        <ModeButton
          label="Auto route"
          icon="auto"
          active={snapshot.mode === "auto"}
          side="right"
          onClick={() => onMode("auto")}
        />
      </div>

      <button
        type="button"
        onClick={onVim}
        aria-pressed={vim}
        aria-label="toggle Vim navigation"
        title="one-key hints on the agent cards (v)"
        className={[
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] border",
          vim ? "border-edge bg-wash text-ink" : "border-rule text-faint hover:text-mid",
        ].join(" ")}
      >
        <Icon name="keyboard" />
      </button>

      <button
        type="button"
        onClick={onTasks}
        aria-pressed={tasksOpen}
        aria-label="toggle tasks"
        title="Tasks"
        className={[
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] border",
          tasksOpen ? "border-edge bg-wash text-ink" : "border-rule text-faint hover:text-mid",
        ].join(" ")}
      >
        <Icon name="tasks" />
      </button>

      <button
        type="button"
        onClick={onWatch}
        aria-pressed={watch}
        aria-label="toggle watch mode"
        title="Watch live agent commands"
        className={[
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] border",
          watch ? "border-edge bg-wash text-ink" : "border-rule text-faint hover:text-mid",
        ].join(" ")}
      >
        <Icon name="terminal" />
      </button>

      {snapshot.views.length > 0 && (
        <nav className="flex" aria-label="views">
          <ViewTab
            label="Fleet"
            icon="terminal"
            active={activeView === null}
            first
            last={false}
            onClick={() => onView(null)}
          />
          {snapshot.views.map((view, index) => (
            <ViewTab
              key={view.id}
              label={view.name}
              icon={VIEWS[view.kind]?.icon ?? "open"}
              active={activeView === view.id}
              first={false}
              last={index === snapshot.views.length - 1}
              onClick={() => onView(view.id)}
            />
          ))}
        </nav>
      )}

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
 * One entry in the view switch. Views carry names, so these are words; the
 * fleet is the view every install has.
 */
function ViewTab({
  label,
  icon,
  active,
  first,
  last,
  onClick,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  first: boolean;
  last: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "flex h-8 cursor-pointer items-center gap-[6px] border px-3 text-[12.5px] transition-colors",
        first ? "rounded-l-[3px]" : "border-l-0",
        last ? "rounded-r-[3px]" : "",
        active ? "border-edge bg-wash text-ink" : "border-rule text-mid hover:text-ink",
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
  side,
  onClick,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  side: "left" | "right";
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
        "flex h-8 w-9 cursor-pointer items-center justify-center transition-colors",
        side === "left" ? "rounded-l-[3px] border" : "rounded-r-[3px] border border-l-0",
        active
          ? "border-edge bg-wash text-ink"
          : "border-rule bg-transparent text-mid hover:text-ink",
      ].join(" ")}
    >
      <Icon name={icon} />
    </button>
  );
}
