"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import type { CardAgent, DiagramEdit, DiagramNode, DiagramPayload } from "../lib/types";
import type { ViewProps } from "./registry";

/** How often to look for an agent's own edits to the file. */
const WATCH_MS = 4000;

const DOT: Record<string, string> = {
  working: "bg-ok",
  stalled: "bg-hold",
  complete: "bg-[#c9c1b5]",
};

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

/**
 * An architecture diagram you edit to change the code.
 *
 * Add a box, draw an arrow, rename or remove one: each is a pending change,
 * previewed in place. Applying them writes the diagram and hands an agent a
 * description of what changed and where that code lives. The file is
 * oxdraw's own format, so oxdraw opens the same diagram.
 */
export function DiagramView({ view, snapshot, revision, busy, run, onOpenAgent, say }: ViewProps) {
  const [base, setBase] = useState<DiagramPayload | null>(null);
  const [preview, setPreview] = useState<DiagramPayload | null>(null);
  const [edits, setEdits] = useState<DiagramEdit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [target, setTarget] = useState("new");
  const [model, setModel] = useState(snapshot.defaultModel || snapshot.models[0]?.id || "");
  const [areaWidth, setAreaWidth] = useState(0);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api.diagram(view.id).then(
      (next) => {
        if (!live) return;
        setBase(next);
        setError(null);
      },
      (failure: unknown) => live && setError(message(failure)),
    );
    return () => {
      live = false;
    };
  }, [view.id, revision]);

  // An agent working on the change edits the same file. Pick that up.
  useEffect(() => {
    const timer = window.setInterval(() => {
      api.diagram(view.id).then(
        (next) => setBase((current) => (current && current.modified === next.modified ? current : next)),
        () => {},
      );
    }, WATCH_MS);
    return () => window.clearInterval(timer);
  }, [view.id]);

  useEffect(() => {
    if (edits.length === 0) return;
    let live = true;
    api.previewDiagram(view.id, edits).then(
      (next) => live && setPreview(next),
      (failure: unknown) => {
        if (!live) return;
        // The daemon refused the last change. Say why and take it back.
        say(message(failure));
        setEdits((current) => current.slice(0, -1));
      },
    );
    return () => {
      live = false;
    };
  }, [edits, view.id, base?.modified, say]);

  // The drawing area only exists once the diagram has loaded.
  const loaded = base !== null;
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAreaWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);

  const shown = edits.length > 0 && preview ? preview : base;
  const agentChoices = useMemo(() => {
    const seen = new Map<string, CardAgent>();
    for (const agent of base?.working ?? []) seen.set(agent.id, agent);
    for (const agent of snapshot.agents) {
      if (!seen.has(agent.id)) {
        seen.set(agent.id, { id: agent.id, name: agent.name, status: agent.status, model: agent.model });
      }
    }
    return [...seen.values()];
  }, [base, snapshot.agents]);

  if (!shown || !base) {
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

  const byId = new Map<string, DiagramNode>([...base.nodes, ...shown.nodes].map((node) => [node.id, node]));
  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  const node = selected ? shown.nodes.find((n) => n.id === selected) ?? null : null;
  const scale = shown.width > 0 ? Math.min((areaWidth - 48) / shown.width, 1.3) : 1;

  const edit = (next: DiagramEdit) => setEdits((current) => [...current, next]);

  const pick = (id: string) => {
    if (connecting && connecting !== id) {
      if (shown.edges.some((e) => e.from === connecting && e.to === id)) {
        say(`${labelOf(connecting)} already points at ${labelOf(id)}`);
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

  const describe = (change: DiagramEdit) => {
    switch (change.op) {
      case "addNode":
        return `Add “${change.label}”`;
      case "addEdge":
        return `Connect ${labelOf(change.from)} → ${labelOf(change.to)}`;
      case "rename":
        return `Rename ${base.nodes.find((n) => n.id === change.id)?.label ?? change.id} to “${change.label}”`;
      case "removeNode":
        return `Remove ${labelOf(change.id)}`;
      case "removeEdge":
        return `Disconnect ${labelOf(change.from)} → ${labelOf(change.to)}`;
    }
  };

  const apply = () =>
    void run(async () => {
      const options = target === "new" ? { model, note } : { agent: target, note };
      const { agent, diagram } = await api.applyDiagram(view.id, edits, options);
      setBase(diagram);
      setEdits([]);
      setPreview(null);
      setNote("");
      say(`${agent.name} is making the code match`);
    });

  const outgoing = node ? shown.edges.filter((e) => e.from === node.id) : [];
  const incoming = node ? shown.edges.filter((e) => e.to === node.id) : [];

  return (
    <section className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-[63px] shrink-0 items-center gap-3 border-b border-rule px-7">
          <span className="text-[15px] font-semibold">{base.name}</span>
          <span className="tnum truncate text-[11.5px] text-faint" title={base.file}>
            {base.file}
          </span>
          <span className="flex-1" />
          {connecting && (
            <span className="text-[12.5px] text-hold">Pick the box {labelOf(connecting)} depends on</span>
          )}
          {edits.length > 0 && (
            <span className="text-[12.5px] text-mid">
              {edits.length} change{edits.length === 1 ? "" : "s"} not applied
            </span>
          )}
        </div>
        <div
          ref={area}
          className="quiet-scroll min-h-0 flex-1 overflow-auto bg-paper p-6"
          onClick={() => {
            setSelected(null);
            setConnecting(null);
          }}
        >
          <div
            className="relative mx-auto rounded-[3px] border border-rule bg-[#fbf9f6]"
            style={{ width: shown.width * scale, height: shown.height * scale }}
          >
            <div
              className="pointer-events-none absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
              // oxdraw's own rendering, so the picture is the one oxdraw draws.
              dangerouslySetInnerHTML={{ __html: shown.svg.replace(/^<\?xml[^>]*>\s*/, "") }}
            />
            {shown.nodes.map((box) => {
              const agents = shown.agents[box.id] ?? base.agents[box.id] ?? [];
              return (
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
                >
                  {agents.length > 0 && (
                    <span className="absolute -top-[7px] -right-[7px] flex gap-[2px] rounded-full border border-rule bg-card px-[4px] py-[3px]">
                      {agents.map((agent) => (
                        <span
                          key={agent.id}
                          className={`h-[7px] w-[7px] rounded-full ${DOT[agent.status] ?? DOT.complete} ${
                            agent.status === "working" ? "pulse" : ""
                          }`}
                        />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {shown.removed.length > 0 && (
            <p className="mx-auto mt-3 text-center text-[12px] text-hold">
              Removing {shown.removed.map(labelOf).join(", ")}
            </p>
          )}
        </div>
      </div>

      <aside className="quiet-scroll flex w-[min(360px,calc(100vw-32px))] shrink-0 flex-col overflow-y-auto border-l border-rule bg-card">
        <div className="border-b border-rule px-5 py-4">
          <span className="text-[12.5px] font-semibold">Add a component</span>
          <div className="mt-2 flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addBox();
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
              className="flex h-9 w-9 cursor-pointer items-center justify-center text-ink disabled:opacity-30"
            >
              <Icon name="plus" />
            </button>
          </div>
        </div>

        {node ? (
          <div className="border-b border-rule px-5 py-4">
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
                className="w-full border-b border-edge bg-transparent py-1 text-[15px] font-semibold outline-none"
              />
            ) : (
              <h2 className="text-[15px] font-semibold">{node.label}</h2>
            )}
            <p className="tnum mt-1 break-all text-[11.5px] text-faint">
              {node.code
                ? `${node.code.file}${node.code.lines ? ` ${node.code.lines}` : ""}`
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
            {(outgoing.length > 0 || incoming.length > 0) && (
              <div className="mt-3 flex flex-col">
                {[...outgoing.map((e) => ({ e, other: e.to, arrow: "→" })), ...incoming.map((e) => ({ e, other: e.from, arrow: "←" }))].map(
                  ({ e, other, arrow }) => (
                    <div key={`${e.from}-${e.to}`} className="group flex items-center gap-2 py-[3px] text-[12.5px]">
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
                  ),
                )}
              </div>
            )}
            {(base.agents[node.id] ?? []).length > 0 && (
              <div className="mt-3 border-t border-hair pt-3">
                {(base.agents[node.id] ?? []).map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => onOpenAgent(agent.id)}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-2 py-[3px] text-left text-[12.5px] text-mid hover:text-ink"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[agent.status] ?? DOT.complete} ${agent.status === "working" ? "pulse" : ""}`} />
                    <span className="truncate">{agent.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="border-b border-rule px-5 py-4 text-[12.5px] leading-relaxed text-faint">
            Pick a box to connect, rename or remove it. The diagram is the spec: an agent makes
            the code match whatever you change here.
          </p>
        )}

        <div className="flex flex-1 flex-col px-5 py-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-semibold">Changes</span>
            <span className="flex-1" />
            {edits.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setEdits((current) => current.slice(0, -1))}
                  className="cursor-pointer text-[12px] text-mid hover:text-ink"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => setEdits([])}
                  className="cursor-pointer text-[12px] text-mid hover:text-ink"
                >
                  Clear
                </button>
              </>
            )}
          </div>
          {edits.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-faint">Nothing changed yet.</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-1">
              {edits.map((change, index) => (
                <li key={index} className="flex gap-2 text-[12.5px]">
                  <span className="tnum text-faint">{index + 1}</span>
                  <span className="min-w-0">{describe(change)}</span>
                </li>
              ))}
            </ol>
          )}

          <div className="mt-4 flex flex-col gap-2 border-t border-hair pt-4">
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="Anything the agent should know"
              aria-label="note for the agent"
              className="resize-none border-b border-edge bg-transparent px-1 py-1 text-[12.5px] outline-none placeholder:text-faint"
            />
            <div className="flex items-stretch gap-2">
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                aria-label="who makes the change"
                className="min-w-0 flex-1 cursor-pointer rounded-[3px] border border-edge bg-wash px-2 py-[7px] text-[12px] outline-none"
              >
                <option value="new">A new agent</option>
                {agentChoices.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {target === "new" && (
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  aria-label="model for the new agent"
                  className="tnum cursor-pointer rounded-[3px] border border-edge bg-wash px-2 text-[12px] outline-none"
                >
                  {snapshot.models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <button
              type="button"
              onClick={apply}
              disabled={busy || edits.length === 0}
              className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-[3px] bg-ink text-[13px] font-semibold text-paper disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="send" size={14} />
              Apply and build it
            </button>
          </div>
        </div>
      </aside>
    </section>
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
