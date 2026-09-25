"use client";

import { useEffect, useMemo, useState } from "react";

import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { api } from "../lib/api";
import { since } from "../lib/format";
import type { Board, Card, CardAgent } from "../lib/types";
import type { ViewProps } from "./registry";

/** Cards drawn per column before "show more". A column of ideas runs long. */
const PAGE = 40;

const DOT: Record<string, string> = {
  working: "bg-ok",
  stalled: "bg-hold",
  complete: "bg-[#c9c1b5]",
};

const PRIORITY: Record<string, string> = {
  p0: "border-ink bg-ink text-paper",
  p1: "border-ink text-ink",
  p2: "border-edge text-mid",
  p3: "border-rule text-faint",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Issues as cards, one column per status, and the agents on each.
 *
 * Moving a card rewrites its `status:` label on GitHub, so a board open on
 * another machine sees it move too. Starting an agent from a card hands it
 * the issue; from then on the card shows the agent and how far its tasks
 * have got, which is the point: the whole plan and the work on it, together.
 */
export function BoardView({ view, snapshot, revision, busy, run, onOpenAgent, say }: ViewProps) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [priorities, setPriorities] = useState<Set<string>>(new Set());
  const [tracks, setTracks] = useState<Set<string>>(new Set());
  const [onlyWorking, setOnlyWorking] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    api.board(view.id).then(
      (next) => {
        if (!live) return;
        setBoard(next);
        setError(null);
      },
      (failure: unknown) => live && setError(message(failure)),
    );
    return () => {
      live = false;
    };
  }, [view.id, revision]);

  // The open card lives in the URL, so a reload lands back on it.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const card = Number(new URL(window.location.href).searchParams.get("card"));
      if (card > 0) setOpen(card);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const openCard = (number: number | null) => {
    setOpen(number);
    const url = new URL(window.location.href);
    if (number) url.searchParams.set("card", String(number));
    else url.searchParams.delete("card");
    window.history.replaceState(null, "", url);
  };

  const refresh = () => {
    setRefreshing(true);
    api
      .board(view.id, true)
      .then(setBoard, (failure: unknown) => say(message(failure)))
      .finally(() => setRefreshing(false));
  };

  const allTracks = useMemo(
    () => [...new Set(board?.cards.flatMap((card) => card.tracks) ?? [])].sort(),
    [board],
  );

  const visible = useMemo(() => {
    if (!board) return [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return board.cards.filter((card) => {
      if (priorities.size > 0 && !priorities.has(card.priority ?? "none")) return false;
      if (tracks.size > 0 && !card.tracks.some((track) => tracks.has(track))) return false;
      if (onlyWorking && card.agents.length === 0) return false;
      if (words.length === 0) return true;
      const haystack = [`#${card.number}`, card.title, card.kind ?? "", ...card.tags]
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [board, query, priorities, tracks, onlyWorking]);

  const move = (card: Card, lane: string) => {
    if (!board || card.lane === lane) return;
    if (!board.writable) {
      say(
        board.source === "snapshot"
          ? "This board reads a snapshot. Give it a repo and a GitHub token to move cards."
          : "Moving a card writes to GitHub, which needs a token.",
      );
      return;
    }
    // Move it now; the daemon's answer replaces this a moment later.
    setBoard({
      ...board,
      cards: board.cards.map((c) => (c.number === card.number ? { ...c, lane } : c)),
    });
    void run(() => api.moveCard(view.id, card.number, lane).then(setBoard));
  };

  const start = (card: Card, options: { model?: string; agent?: string }) =>
    void run(async () => {
      const { agent } = await api.startCard(view.id, card.number, options);
      say(`${agent.name} is on #${card.number}`);
    });

  const unlink = (card: Card, agent: CardAgent) =>
    void run(() => api.unlink(view.id, `#${card.number}`, agent.id));

  if (!board) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center px-8">
        <p className="max-w-[60ch] text-center text-[13px] leading-relaxed text-faint">
          {error ? (
            <>
              {view.name} could not load.
              <br />
              <span className="text-mid">{error}</span>
            </>
          ) : (
            `Loading ${view.name}…`
          )}
        </p>
      </section>
    );
  }

  const selected = board.cards.find((card) => card.number === open) ?? null;
  const agentsWorking = new Set(
    board.cards.flatMap((card) => card.agents.filter((a) => a.status === "working").map((a) => a.id)),
  ).size;

  const toggle = (set: Set<string>, value: string, update: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    update(next);
  };

  return (
    <section className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-[63px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-7 py-2">
          <span className="text-[15px] font-semibold">{board.name}</span>
          <span className="text-[12.5px] text-faint">
            {visible.length === board.cards.length
              ? `${board.cards.length} cards`
              : `${visible.length} of ${board.cards.length}`}
            {agentsWorking > 0 && `, ${agentsWorking} agent${agentsWorking === 1 ? "" : "s"} working`}
          </span>
          <span
            className={`tnum text-[11px] ${board.writable ? "text-ok" : "text-hold"}`}
            title={board.warning ?? undefined}
          >
            {board.source === "github" ? `live from ${board.repo}` : "snapshot"}
            {!board.writable && ", read only"}
          </span>
          <span className="flex-1" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter cards"
            aria-label="filter cards"
            className="w-[180px] border-b border-edge bg-transparent px-1 py-1 text-[12.5px] outline-none placeholder:text-faint"
          />
          <span className="flex items-center gap-1" role="group" aria-label="priority">
            {["p0", "p1", "p2", "p3"].map((p) => (
              <Chip key={p} on={priorities.has(p)} onClick={() => toggle(priorities, p, setPriorities)}>
                {p}
              </Chip>
            ))}
          </span>
          {allTracks.length > 0 && (
            <span className="flex items-center gap-1" role="group" aria-label="track">
              {allTracks.map((track) => (
                <Chip key={track} on={tracks.has(track)} onClick={() => toggle(tracks, track, setTracks)}>
                  {track}
                </Chip>
              ))}
            </span>
          )}
          <Chip on={onlyWorking} onClick={() => setOnlyWorking((current) => !current)}>
            with agents
          </Chip>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="fetch the board again"
            title={`Fetched ${since(board.fetchedAt)} ago`}
            className="flex h-8 w-8 cursor-pointer items-center justify-center text-mid hover:text-ink disabled:opacity-40"
          >
            <span className={refreshing ? "pulse" : ""}>
              <Icon name="refresh" />
            </span>
          </button>
        </div>

        {board.warning && (
          <p className="shrink-0 border-b border-hair bg-band px-7 py-2 text-[12px] text-hold">{board.warning}</p>
        )}

        <div className="quiet-scroll flex min-h-0 flex-1 gap-4 overflow-x-auto px-7 py-5">
          {board.lanes.map((lane) => {
            const cards = visible.filter((card) => card.lane === lane.id);
            const limit = shown[lane.id] ?? PAGE;
            return (
              <div
                key={lane.id}
                onDragOver={(event) => {
                  if (dragging === null) return;
                  event.preventDefault();
                  setOver(lane.id);
                }}
                onDragLeave={() => setOver((current) => (current === lane.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const card = board.cards.find((c) => c.number === dragging);
                  setDragging(null);
                  setOver(null);
                  if (card) move(card, lane.id);
                }}
                className={[
                  "flex w-[280px] shrink-0 flex-col rounded-[3px] border",
                  over === lane.id ? "border-ink bg-wash" : "border-rule bg-band",
                ].join(" ")}
              >
                <div className="flex shrink-0 items-baseline gap-2 border-b border-rule px-3 py-[10px]">
                  <span className="text-[13px] font-semibold">{lane.name}</span>
                  <span className="tnum text-[11.5px] text-faint">{cards.length}</span>
                </div>
                <div className="quiet-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {cards.slice(0, limit).map((card) => (
                    <CardTile
                      key={card.number}
                      card={card}
                      selected={card.number === open}
                      draggable
                      onDragStart={() => setDragging(card.number)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onOpen={() => openCard(card.number)}
                      onOpenAgent={onOpenAgent}
                    />
                  ))}
                  {cards.length > limit && (
                    <button
                      type="button"
                      onClick={() => setShown((current) => ({ ...current, [lane.id]: limit + PAGE }))}
                      className="cursor-pointer py-2 text-[12px] text-mid hover:text-ink"
                    >
                      {cards.length - limit} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {board.hidden > 0 && (
          <p className="shrink-0 px-7 pb-3 text-[11.5px] text-faint">
            {board.hidden} issue{board.hidden === 1 ? " has a status" : "s have statuses"} with no column here.
          </p>
        )}
      </div>

      {selected && (
        <CardDetail
          key={selected.number}
          card={selected}
          board={board}
          models={snapshot.models}
          defaultModel={snapshot.defaultModel}
          busy={busy}
          onClose={() => openCard(null)}
          onMove={(lane) => move(selected, lane)}
          onStart={(options) => start(selected, options)}
          onUnlink={(agent) => unlink(selected, agent)}
          onOpenAgent={onOpenAgent}
        />
      )}
    </section>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={[
        "tnum cursor-pointer rounded-[3px] border px-[7px] py-[2px] text-[11px]",
        on ? "border-edge bg-wash text-ink" : "border-rule text-faint hover:text-mid",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function AgentDot({ agent }: { agent: CardAgent }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${DOT[agent.status] ?? DOT.complete} ${
        agent.status === "working" ? "pulse" : ""
      }`}
    />
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-hair">
        <span
          className="block h-full rounded-full bg-ok transition-[width]"
          style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }}
        />
      </span>
      <span className="tnum text-[11px] text-faint">
        {done}/{total}
      </span>
    </span>
  );
}

function CardTile({
  card,
  selected,
  draggable,
  onDragStart,
  onDragEnd,
  onOpen,
  onOpenAgent,
}: {
  card: Card;
  selected: boolean;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onOpenAgent: (id: string) => void;
}) {
  return (
    <article
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(card.number));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={[
        "cursor-pointer rounded-[3px] bg-card px-3 py-[10px] transition-colors",
        selected ? "border-2 border-ink px-[11px] py-[9px]" : "border border-rule hover:border-edge",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="tnum text-faint">#{card.number}</span>
        {card.priority && (
          <span className={`tnum rounded-[2px] border px-[5px] leading-[16px] ${PRIORITY[card.priority] ?? PRIORITY.p3}`}>
            {card.priority}
          </span>
        )}
        {card.kind && <span className="text-faint">{card.kind}</span>}
        <span className="flex-1" />
        {card.agents.map((agent) => (
          <AgentDot key={agent.id} agent={agent} />
        ))}
      </div>
      <p className={`mt-[5px] line-clamp-3 text-[13px] leading-[1.4] ${card.open ? "text-ink" : "text-mid"}`}>
        {card.title}
      </p>
      {card.agents.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-hair pt-2">
          {card.agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenAgent(agent.id);
              }}
              className="flex min-w-0 cursor-pointer items-center gap-[6px] text-left text-[11.5px] text-mid hover:text-ink"
            >
              <AgentDot agent={agent} />
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
          {card.tasksTotal > 0 && <Progress done={card.tasksDone} total={card.tasksTotal} />}
        </div>
      )}
    </article>
  );
}

function CardDetail({
  card,
  board,
  models,
  defaultModel,
  busy,
  onClose,
  onMove,
  onStart,
  onUnlink,
  onOpenAgent,
}: {
  card: Card;
  board: Board;
  models: { id: string; label: string; backend: string }[];
  defaultModel: string;
  busy: boolean;
  onClose: () => void;
  onMove: (lane: string) => void;
  onStart: (options: { model?: string; agent?: string }) => void;
  onUnlink: (agent: CardAgent) => void;
  onOpenAgent: (id: string) => void;
}) {
  const [model, setModel] = useState(defaultModel || models[0]?.id || "");
  const latest = card.agents.at(-1);

  return (
    <aside className="flex w-[min(440px,calc(100vw-32px))] shrink-0 flex-col border-l border-rule bg-card">
      <header className="flex min-h-[63px] shrink-0 items-center gap-3 border-b border-rule px-5">
        <span className="tnum text-[12px] text-faint">#{card.number}</span>
        {card.url && (
          <a
            href={card.url}
            target="_blank"
            rel="noreferrer"
            aria-label="open the issue"
            title="Open the issue"
            className="text-faint hover:text-ink"
          >
            <Icon name="external" size={14} />
          </a>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="close card"
          title="Close"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-faint hover:text-ink"
        >
          <Icon name="expand" />
        </button>
      </header>

      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-rule px-5 py-4">
          <h2 className="text-[16px] font-semibold leading-snug">{card.title}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
            <select
              value={card.lane}
              disabled={busy || !board.writable}
              onChange={(event) => onMove(event.target.value)}
              aria-label="column"
              title={board.writable ? "Move to another column" : "Read only"}
              className="cursor-pointer rounded-[3px] border border-edge bg-wash px-2 py-1 text-[12px] outline-none disabled:cursor-default disabled:opacity-70"
            >
              {board.lanes.map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.name}
                </option>
              ))}
            </select>
            {card.priority && (
              <span className={`tnum rounded-[2px] border px-[5px] ${PRIORITY[card.priority] ?? PRIORITY.p3}`}>
                {card.priority}
              </span>
            )}
            {[card.kind, ...card.tracks, ...card.tags].filter(Boolean).map((label) => (
              <span key={label} className="rounded-[2px] border border-rule px-[5px] text-faint">
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="border-b border-rule px-5 py-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-semibold">Agents</span>
            {card.tasksTotal > 0 && (
              <span className="flex-1">
                <Progress done={card.tasksDone} total={card.tasksTotal} />
              </span>
            )}
          </div>
          {card.agents.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-faint">Nobody is on this yet.</p>
          ) : (
            <div className="mt-2 flex flex-col">
              {card.agents.map((agent) => (
                <div key={agent.id} className="group flex items-center gap-2 py-[5px]">
                  <AgentDot agent={agent} />
                  <button
                    type="button"
                    onClick={() => onOpenAgent(agent.id)}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-[13px] hover:underline"
                  >
                    {agent.name}
                  </button>
                  <span className="tnum text-[11px] text-faint">{agent.model}</span>
                  <button
                    type="button"
                    onClick={() => onUnlink(agent)}
                    disabled={busy}
                    aria-label={`take ${agent.name} off this card`}
                    title="Take off this card"
                    className="flex h-6 w-6 cursor-pointer items-center justify-center text-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-ink"
                  >
                    <Icon name="discard" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex items-stretch gap-2">
            <span className="flex items-stretch">
              <button
                type="button"
                disabled={busy || !model}
                onClick={() => onStart({ model })}
                className="flex h-9 cursor-pointer items-center gap-2 rounded-l-[3px] bg-ink px-3 text-[12.5px] font-semibold text-paper disabled:opacity-40"
              >
                <Icon name="play" size={13} />
                Start an agent
              </button>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={busy}
                aria-label="model for the new agent"
                className="tnum cursor-pointer rounded-r-[3px] border border-l-0 border-edge bg-wash px-2 text-[12px] outline-none"
              >
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </span>
            {latest && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onStart({ agent: latest.id })}
                title={`Send the issue to ${latest.name} again`}
                className="h-9 cursor-pointer rounded-[3px] border border-rule px-3 text-[12.5px] text-mid hover:text-ink disabled:opacity-40"
              >
                Send again
              </button>
            )}
          </div>
        </div>

        <div className="px-5 py-4 text-[13px] leading-[1.55]">
          {card.body.trim() ? <Markdown>{card.body}</Markdown> : <p className="text-faint">No description.</p>}
        </div>
      </div>
    </aside>
  );
}
