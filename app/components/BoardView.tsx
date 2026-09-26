"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { since } from "../lib/format";
import type { Agent, Arranged, Board, Snapshot } from "../lib/types";
import { Icon } from "./Icon";
import { TagChip } from "./Tags";

const DOT: Record<string, string> = {
  working: "bg-ok",
  stalled: "bg-hold",
  complete: "bg-[#c9c1b5]",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Which cell a drop lands in. Null is the lane of sessions without the key. */
type Cell = { column: string | null; row: string | null };
const cellKey = (cell: Cell) => `${cell.row ?? "\u0000"}|${cell.column ?? "\u0000"}`;

/**
 * Sessions arranged by their tags.
 *
 * Nothing here knows what a tag means. The board says which key makes the
 * columns and which the rows; a card sits in the cell its two tags name,
 * and dropping it in another cell sets those two tags. Every setting is
 * saved to the daemon as soon as it changes, so the same board looks the
 * same from every surface and an agent can rearrange it too.
 */
export function BoardView({
  board,
  snapshot,
  revision,
  busy,
  run,
  onOpenAgent,
  onDeleted,
  say,
}: {
  board: Board;
  snapshot: Snapshot;
  revision: number;
  busy: boolean;
  run: (work: () => Promise<unknown>, after?: () => void) => Promise<void>;
  onOpenAgent: (id: string) => void;
  onDeleted: () => void;
  say: (text: string) => void;
}) {
  const [arranged, setArranged] = useState<Arranged | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.arrange(board.id).then(
      (next) => {
        if (!live) return;
        setArranged(next);
        setError(null);
      },
      (failure: unknown) => live && setError(message(failure)),
    );
    return () => {
      live = false;
    };
  }, [board.id, board.updatedAt, revision]);

  const keys = useMemo(() => Object.keys(arranged?.values ?? {}).sort(), [arranged]);

  if (!arranged) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center text-[13px] text-faint">
        {error ?? `Loading ${board.name}…`}
      </section>
    );
  }

  const settings = arranged.board;
  const save = (patch: Partial<Board>) => {
    const next = { ...settings, ...patch };
    setArranged({ ...arranged, board: next });
    void run(() => api.updateBoard(next));
  };

  const move = (agent: string, to: Cell) => {
    // Move it now; the daemon's layout replaces this a moment later.
    const rows = arranged.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => cell.filter((id) => id !== agent)),
    }));
    const column = arranged.columns.indexOf(to.column);
    const row = rows.find((r) => r.value === to.row) ?? rows[0];
    if (row && column >= 0) row.cells[column] = [agent, ...row.cells[column]];
    setArranged({ ...arranged, rows });
    void run(() => api.moveCard(board.id, agent, to.column, to.row));
  };

  const reorder = (lane: "columns" | "rows", value: string, delta: number) => {
    const values =
      lane === "columns"
        ? arranged.columns.filter((v): v is string => v !== null)
        : arranged.rows.map((r) => r.value).filter((v): v is string => v !== null);
    const at = values.indexOf(value);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= values.length) return;
    [values[at], values[to]] = [values[to], values[at]];
    save(lane === "columns" ? { columnOrder: values } : { rowOrder: values });
  };

  const addLane = (lane: "columns" | "rows", value: string) => {
    const clean = value.trim().toLowerCase().replace(/\s+/g, "-");
    if (!clean) return;
    const current =
      lane === "columns"
        ? arranged.columns.filter((v): v is string => v !== null)
        : arranged.rows.map((r) => r.value).filter((v): v is string => v !== null);
    if (current.includes(clean)) return;
    save(lane === "columns" ? { columnOrder: [...current, clean] } : { rowOrder: [...current, clean] });
  };

  const toggle = (tag: string) =>
    save({
      selected: settings.selected.includes(tag)
        ? settings.selected.filter((t) => t !== tag)
        : [...settings.selected, tag],
    });

  const untagged = keys.length === 0 && arranged.plain.length === 0;
  const hidden = new Set([settings.columns, settings.rows].filter(Boolean));
  const gridded = settings.rows !== "";
  const card = (id: string) => {
    const agent = arranged.sessions[id];
    if (!agent) return null;
    return (
      <SessionCard
        key={id}
        agent={agent}
        tags={(snapshot.tags[id] ?? []).filter((tag) => !hidden.has(tag.split(":")[0]))}
        dragging={dragging === id}
        onDragStart={() => setDragging(id)}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
        onOpen={() => onOpenAgent(id)}
      />
    );
  };
  const drop = (cell: Cell) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragging) return;
      event.preventDefault();
      setOver(cellKey(cell));
    },
    onDragLeave: () => setOver((current) => (current === cellKey(cell) ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const agent = dragging;
      setDragging(null);
      setOver(null);
      if (agent) move(agent, cell);
    },
  });
  const laneName = (key: string, value: string | null) => value ?? (key ? `No ${key}` : "All");

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-[63px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-7 py-2">
        {name !== null ? (
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setName(null);
            }}
            onBlur={() => {
              if (name.trim() && name.trim() !== settings.name) save({ name: name.trim() });
              setName(null);
            }}
            aria-label="board name"
            className="border-b border-edge bg-transparent py-1 text-[15px] font-semibold outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setName(settings.name)}
            title="Rename"
            className="cursor-text text-[15px] font-semibold hover:underline"
          >
            {settings.name}
          </button>
        )}
        <span className="text-[12.5px] text-faint">
          {arranged.shown === arranged.total
            ? `${arranged.total} session${arranged.total === 1 ? "" : "s"}`
            : `${arranged.shown} of ${arranged.total}`}
        </span>
        <span className="flex-1" />
        <KeyPicker label="Columns" value={settings.columns} keys={keys} onChange={(columns) => save({ columns })} />
        <KeyPicker label="Rows" value={settings.rows} keys={keys} onChange={(rows) => save({ rows })} />
        <KeyPicker label="Sort" value={settings.sort} keys={keys} none="recent" onChange={(sort) => save({ sort })} />
        <KeyPicker
          label="Filter"
          value=""
          keys={keys.filter((key) => !settings.filters.includes(key))}
          none="+ key"
          onChange={(key) => key && save({ filters: [...settings.filters, key] })}
        />
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await api.deleteBoard(board.id);
              say(`Deleted ${settings.name}`);
              onDeleted();
            })
          }
          disabled={busy}
          aria-label="delete board"
          title="Delete board"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-faint hover:text-ink"
        >
          <Icon name="discard" />
        </button>
      </div>

      {settings.filters.length > 0 && (
        <div className="flex shrink-0 flex-col gap-[6px] border-b border-hair px-7 py-2">
          {settings.filters.map((key) => (
            <div key={key} className="flex flex-wrap items-center gap-[5px]" role="group" aria-label={`filter by ${key}`}>
              <span className="w-[70px] shrink-0 text-[11.5px] text-faint">{key}</span>
              {(arranged.values[key] ?? []).map((value) => {
                const tag = `${key}:${value}`;
                const on = settings.selected.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(tag)}
                    className={[
                      "cursor-pointer rounded-[3px] border px-[7px] py-[1px] text-[11.5px]",
                      on ? "border-edge bg-wash text-ink" : "border-rule text-faint hover:text-mid",
                    ].join(" ")}
                  >
                    {value}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() =>
                  save({
                    filters: settings.filters.filter((k) => k !== key),
                    selected: settings.selected.filter((t) => !t.startsWith(`${key}:`)),
                  })
                }
                aria-label={`stop filtering by ${key}`}
                title="Remove filter"
                className="cursor-pointer px-1 text-[12px] text-faint hover:text-ink"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {untagged ? (
        <p className="max-w-[60ch] px-7 py-6 text-[13px] leading-relaxed text-faint">
          No session is tagged yet. Tag one from its header — <span className="tnum">stage:idea</span>,{" "}
          <span className="tnum">project:agents</span> — or ask its agent to tag itself. Then pick a
          key for the columns, and another for the rows.
        </p>
      ) : (
        <div className="quiet-scroll min-h-0 flex-1 overflow-auto px-7 py-5">
          <div
            className="grid gap-3"
            style={{
              // Columns share the width, never narrower than a card.
              gridTemplateColumns: `${gridded ? "132px " : ""}repeat(${arranged.columns.length}, minmax(210px, 1fr)) 96px`,
              minHeight: gridded ? undefined : "100%",
              gridTemplateRows: gridded ? undefined : "auto 1fr",
            }}
          >
            {gridded && <div />}
            {arranged.columns.map((column) => (
              <LaneHead
                key={column ?? "\u0000"}
                name={laneName(settings.columns, column)}
                count={arranged.rows.reduce((sum, row) => sum + row.cells[arranged.columns.indexOf(column)].length, 0)}
                empty={column === null}
                onEarlier={column && settings.columns ? () => reorder("columns", column, -1) : undefined}
                onLater={column && settings.columns ? () => reorder("columns", column, 1) : undefined}
              />
            ))}
            {settings.columns ? (
              <AddLane label="column" onAdd={(value) => addLane("columns", value)} />
            ) : (
              <div />
            )}

            {arranged.rows.map((row) => (
              <Lane key={row.value ?? "\u0000"}>
                {gridded && (
                  <LaneHead
                    name={laneName(settings.rows, row.value)}
                    count={row.cells.reduce((sum, cell) => sum + cell.length, 0)}
                    empty={row.value === null}
                    vertical
                    onEarlier={row.value ? () => reorder("rows", row.value as string, -1) : undefined}
                    onLater={row.value ? () => reorder("rows", row.value as string, 1) : undefined}
                  />
                )}
                {row.cells.map((cell, index) => {
                  const target: Cell = { column: arranged.columns[index], row: row.value };
                  return (
                    <div
                      key={index}
                      {...drop(target)}
                      className={[
                        "flex min-h-[96px] flex-col gap-2 rounded-[3px] border p-2",
                        over === cellKey(target) ? "border-ink bg-wash" : "border-rule bg-band",
                      ].join(" ")}
                    >
                      {cell.map(card)}
                    </div>
                  );
                })}
                <div />
              </Lane>
            ))}
            {gridded && (
              <>
                <AddLane label="row" onAdd={(value) => addLane("rows", value)} />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Children of the grid, laid in its cells without a box of their own. */
function Lane({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function KeyPicker({
  label,
  value,
  keys,
  none = "none",
  onChange,
}: {
  label: string;
  value: string;
  keys: string[];
  none?: string;
  onChange: (key: string) => void;
}) {
  const options = value && !keys.includes(value) ? [value, ...keys] : keys;
  return (
    <label className="flex items-center gap-[6px] text-[12px] text-faint">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label.toLowerCase()}
        className="cursor-pointer rounded-[3px] border border-rule bg-card px-[6px] py-[3px] text-[12px] text-ink outline-none"
      >
        <option value="">{none}</option>
        {options.map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>
    </label>
  );
}

function LaneHead({
  name,
  count,
  empty,
  vertical = false,
  onEarlier,
  onLater,
}: {
  name: string;
  count: number;
  empty: boolean;
  vertical?: boolean;
  onEarlier?: () => void;
  onLater?: () => void;
}) {
  return (
    <div
      className={[
        "group relative flex items-center gap-2 px-1",
        vertical ? "self-start pt-2" : "pb-1",
      ].join(" ")}
    >
      <span className={`truncate text-[13px] font-semibold ${empty ? "text-faint" : "text-ink"}`}>{name}</span>
      <span className="tnum text-[11.5px] text-faint">{count}</span>
      <span className="flex-1" />
      {onEarlier && (
        // Floats over the lane's edge, so the name keeps the whole width.
        <span className="absolute top-0 right-0 flex bg-paper opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={onEarlier}
            aria-label={`move ${name} ${vertical ? "up" : "left"}`}
            className="cursor-pointer px-1 text-[12px] text-faint hover:text-ink"
          >
            {vertical ? "↑" : "←"}
          </button>
          <button
            type="button"
            onClick={onLater}
            aria-label={`move ${name} ${vertical ? "down" : "right"}`}
            className="cursor-pointer px-1 text-[12px] text-faint hover:text-ink"
          >
            {vertical ? "↓" : "→"}
          </button>
        </span>
      )}
    </div>
  );
}

function AddLane({ label, onAdd }: { label: string; onAdd: (value: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onAdd(draft);
          setDraft("");
        }
      }}
      placeholder={`+ ${label}`}
      aria-label={`add a ${label}`}
      className="h-7 self-start border-b border-transparent bg-transparent px-1 text-[12px] outline-none placeholder:text-faint focus:border-edge"
    />
  );
}

function SessionCard({
  agent,
  tags,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  agent: Agent;
  tags: string[];
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  return (
    <article
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", agent.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={[
        "cursor-pointer rounded-[3px] border border-rule bg-card px-3 py-[9px] transition-opacity hover:border-edge",
        dragging ? "opacity-40" : "",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${DOT[agent.status] ?? DOT.complete}`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{agent.name}</span>
        <span className="tnum shrink-0 text-[10.5px] text-faint">{since(agent.updatedAt)}</span>
      </div>
      {agent.status === "working" && agent.activity && (
        <p className="mt-[5px] truncate font-mono text-[10.5px] text-mid">{agent.activity}</p>
      )}
      {tags.length > 0 && (
        <div className="mt-[6px] flex flex-wrap gap-[4px]">
          {tags.map((tag) => (
            <TagChip key={tag} tag={tag} quiet />
          ))}
        </div>
      )}
    </article>
  );
}
