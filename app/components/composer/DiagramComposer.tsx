"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import type { DiagramEdit, DiagramNode, DiagramPayload } from "../../lib/types";
import { Icon } from "../Icon";

/** How often to look for the agent's own edits to the file. */
const WATCH_MS = 4000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `Board cache` -> `board_cache`, unique among the boxes already there. */
function newId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "n$1") || "box";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  return id;
}

/** A pending change, in words, for the list under the picture. */
export function describeEdit(change: DiagramEdit, labelOf: (id: string) => string): string {
  switch (change.op) {
    case "addNode":
      return `Add “${change.label}”`;
    case "addEdge":
      return `${labelOf(change.from)} depends on ${labelOf(change.to)}`;
    case "rename":
      return `Rename ${labelOf(change.id)} to “${change.label}”`;
    case "removeNode":
      return `Remove ${labelOf(change.id)}`;
    case "removeEdge":
      return `${labelOf(change.from)} no longer depends on ${labelOf(change.to)}`;
  }
}

/**
 * Drawing a message instead of typing one: the agent's architecture
 * diagram, edited in place.
 *
 * Every edit is pending until the composer sends them, and the daemon draws
 * each preview, so this holds a list and a picture and nothing else. Sending
 * writes the diagram and tells the agent what changed and where that code is.
 */
export function DiagramComposer({
  agentId,
  edits,
  onEdits,
  onCreate,
  say,
  busy,
}: {
  agentId: string;
  edits: DiagramEdit[];
  onEdits: (update: (current: DiagramEdit[]) => DiagramEdit[]) => void;
  /// `about` narrows what to draw; empty asks for the whole architecture.
  onCreate: (about: string) => void;
  say: (text: string) => void;
  busy: boolean;
}) {
  const [base, setBase] = useState<DiagramPayload | null>(null);
  const [preview, setPreview] = useState<DiagramPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  /// What a diagram asked for should cover. Empty asks for all of it.
  const [about, setAbout] = useState("");
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const area = useRef<HTMLDivElement>(null);

  // Load it, and keep looking: the agent edits the same file.
  useEffect(() => {
    let live = true;
    const load = () =>
      api.diagram(agentId).then(
        (next) => {
          if (!live) return;
          setBase((current) => (current && current.modified === next.modified ? current : next));
          setError(null);
        },
        (failure: unknown) => live && setError(message(failure)),
      );
    load();
    const timer = window.setInterval(load, WATCH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [agentId]);

  useEffect(() => {
    if (edits.length === 0) return;
    let live = true;
    api.previewDiagram(agentId, edits).then(
      (next) => live && setPreview(next),
      (failure: unknown) => {
        if (!live) return;
        // The daemon refused the last change. Say why and take it back.
        say(message(failure));
        onEdits((current) => current.slice(0, -1));
      },
    );
    return () => {
      live = false;
    };
  }, [agentId, edits, base?.modified, say, onEdits]);

  const loaded = base?.exists === true;
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);

  if (!base) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-faint">
        {error ?? "Loading the diagram…"}
      </div>
    );
  }
  if (!base.exists) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <p className="max-w-[56ch] text-[13px] leading-relaxed text-mid">
          This repository has no diagram yet at
          <br />
          <span className="tnum text-[12px] text-ink">{base.file}</span>
        </p>
        <div className="flex w-full max-w-[52ch] items-center gap-2">
          <input
            value={about}
            onChange={(event) => setAbout(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) onCreate(about);
            }}
            placeholder="Of what? The whole thing, unless you say"
            className="h-9 min-w-0 flex-1 border-b border-edge bg-transparent px-1 text-[13px] outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={() => onCreate(about)}
            disabled={busy}
            className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-[3px] bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-40"
          >
            <Icon name="diagram" size={14} />
            Ask the agent to draw one
          </button>
        </div>
      </div>
    );
  }

  const shown = edits.length > 0 && preview?.exists ? preview : base;
  const byId = new Map<string, DiagramNode>([...base.nodes, ...shown.nodes].map((node) => [node.id, node]));
  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  const node = selected ? shown.nodes.find((n) => n.id === selected) ?? null : null;
  // The whole diagram in view: fit the width and the height, never blow it up much.
  const scale =
    shown.width > 0 && room.width > 0
      ? Math.max(Math.min((room.width - 32) / shown.width, (room.height - 48) / shown.height, 1.25), 0.35)
      : 1;
  const edit = (next: DiagramEdit) => onEdits((current) => [...current, next]);

  const pick = (id: string) => {
    if (connecting && connecting !== id) {
      if (shown.edges.some((e) => e.from === connecting && e.to === id)) {
        say(`${labelOf(connecting)} already depends on ${labelOf(id)}`);
      } else {
        edit({ op: "addEdge", from: connecting, to: id });
      }
      setConnecting(null);
    }
    setSelected(id);
    setRenaming(null);
  };

  const addBox = () => {
    const label = draft.trim();
    if (!label) return;
    const id = newId(label, new Set(shown.nodes.map((n) => n.id)));
    edit({ op: "addNode", id, label });
    // With a box selected, the new one hangs off it: that is nearly always
    // what adding a component next to another one means.
    if (selected) edit({ op: "addEdge", from: selected, to: id });
    setDraft("");
    setSelected(id);
  };

  const links = node
    ? [
        ...shown.edges.filter((e) => e.from === node.id).map((e) => ({ e, other: e.to, arrow: "→" })),
        ...shown.edges.filter((e) => e.to === node.id).map((e) => ({ e, other: e.from, arrow: "←" })),
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1">
      <div
        ref={area}
        className="quiet-scroll min-h-0 min-w-0 flex-1 overflow-auto bg-paper p-4"
        onClick={() => {
          setSelected(null);
          setConnecting(null);
        }}
      >
        <p className="tnum mb-2 truncate text-[11px] text-faint" title={base.file}>
          {base.file}
        </p>
        <div
          className="relative mx-auto rounded-[3px] border border-rule bg-[#fbf9f6]"
          style={{ width: shown.width * scale, height: shown.height * scale }}
        >
          <div
            className="pointer-events-none absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
            // oxdraw's own rendering, so the picture is the one oxdraw draws.
            dangerouslySetInnerHTML={{ __html: shown.svg.replace(/^<\?xml[^>]*>\s*/, "") }}
          />
          {shown.nodes.map((box) => (
            <button
              key={box.id}
              type="button"
              aria-label={box.label}
              title={box.code ? `${box.label}\n${box.code.file}` : box.label}
              onClick={(event) => {
                event.stopPropagation();
                pick(box.id);
              }}
              className={[
                "absolute cursor-pointer rounded-[6px]",
                box.id === selected
                  ? "ring-2 ring-ink ring-offset-2 ring-offset-[#fbf9f6]"
                  : connecting
                    ? "ring-1 ring-hold hover:ring-2"
                    : "hover:ring-1 hover:ring-edge",
              ].join(" ")}
              style={{
                left: box.x * scale,
                top: box.y * scale,
                width: box.width * scale,
                height: box.height * scale,
              }}
            />
          ))}
        </div>
        {connecting && (
          <p className="mt-2 text-center text-[12.5px] text-hold">
            Pick the box {labelOf(connecting)} depends on
          </p>
        )}
      </div>

      <aside className="quiet-scroll flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-rule bg-card">
        <div className="border-b border-rule px-4 py-3">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addBox();
                }
              }}
              placeholder={node ? `New box under ${node.label}` : "New box"}
              aria-label="new box label"
              className="min-w-0 flex-1 border-b border-edge bg-transparent px-1 py-[6px] text-[13px] outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={addBox}
              disabled={!draft.trim()}
              aria-label="add the box"
              title="Add"
              className="flex h-8 w-8 cursor-pointer items-center justify-center text-ink disabled:opacity-30"
            >
              <Icon name="plus" />
            </button>
          </div>
        </div>

        {node ? (
          <div className="border-b border-rule px-4 py-3">
            {renaming !== null ? (
              <input
                autoFocus
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    const label = renaming.trim();
                    if (label && label !== node.label) edit({ op: "rename", id: node.id, label });
                    setRenaming(null);
                  }
                  if (event.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming(null)}
                aria-label="new name"
                className="w-full border-b border-edge bg-transparent py-1 text-[14px] font-semibold outline-none"
              />
            ) : (
              <h3 className="text-[14px] font-semibold">{node.label}</h3>
            )}
            <p className="tnum mt-1 break-all text-[11px] text-faint">
              {node.code
                ? node.code.file
                : node.change === "added"
                  ? "new, no code yet"
                  : "not mapped to code"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <SmallButton onClick={() => setConnecting(node.id)} active={connecting === node.id}>
                Depends on…
              </SmallButton>
              <SmallButton onClick={() => setRenaming(node.label)}>Rename</SmallButton>
              <SmallButton
                onClick={() => {
                  edit({ op: "removeNode", id: node.id });
                  setSelected(null);
                }}
              >
                Remove
              </SmallButton>
            </div>
            {links.length > 0 && (
              <div className="mt-3 flex flex-col">
                {links.map(({ e, other, arrow }) => (
                  <div key={`${e.from}-${e.to}`} className="group flex items-center gap-2 py-[2px] text-[12.5px]">
                    <span className="text-faint">{arrow}</span>
                    <button
                      type="button"
                      onClick={() => pick(other)}
                      className={`min-w-0 flex-1 cursor-pointer truncate text-left hover:underline ${e.added ? "text-ok" : "text-mid"}`}
                    >
                      {labelOf(other)}
                    </button>
                    <button
                      type="button"
                      onClick={() => edit({ op: "removeEdge", from: e.from, to: e.to })}
                      aria-label={`disconnect ${labelOf(other)}`}
                      title="Disconnect"
                      className="flex h-5 w-5 cursor-pointer items-center justify-center text-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-ink"
                    >
                      <Icon name="discard" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="border-b border-rule px-4 py-3 text-[12.5px] leading-relaxed text-faint">
            Pick a box to connect, rename or remove it. Send the change and the agent makes the
            code match.
          </p>
        )}

        <div className="px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-semibold">Changes</span>
            <span className="flex-1" />
            {edits.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => onEdits((current) => current.slice(0, -1))}
                  className="cursor-pointer text-[12px] text-mid hover:text-ink"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => onEdits(() => [])}
                  className="cursor-pointer text-[12px] text-mid hover:text-ink"
                >
                  Clear
                </button>
              </>
            )}
          </div>
          {edits.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-faint">Nothing drawn yet.</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-1">
              {edits.map((change, index) => (
                <li key={index} className="flex gap-2 text-[12.5px]">
                  <span className="tnum text-faint">{index + 1}</span>
                  <span className="min-w-0">{describeEdit(change, labelOf)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}

function SmallButton({
  onClick,
  active = false,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "cursor-pointer rounded-[3px] border px-[9px] py-[4px] text-[12px]",
        active ? "border-hold text-hold" : "border-rule text-mid hover:text-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
