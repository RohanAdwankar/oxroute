"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import type { DiffQuote } from "../lib/drafts";

type Review = {
  id: string; title: string; description: string; status: "pending" | "approved" | "stale";
  snapshot: { repository: string; remote: string; remoteUrl: string; branch: string;
    baseRef: string; baseCommit: string; headCommit: string; files: { path: string; patch: string }[] };
};
type Line = { text: string; old: number | null; next: number | null };

function lines(patch: string): Line[] {
  let old = 0, next = 0, hunk = false;
  return patch.split("\n").map(text => {
    if (text.startsWith("@@ ")) {
      const [, before, after] = text.split(" ");
      old = Number(before.slice(1).split(",")[0]);
      next = Number(after.slice(1).split(",")[0]);
      hunk = true;
      return { text, old: null, next: null };
    }
    const sign = text[0];
    if (!hunk || !["+", "-", " "].includes(sign)) return { text, old: null, next: null };
    return { text, old: sign === "+" ? null : old++, next: sign === "-" ? null : next++ };
  }).filter(row => row.old !== null || row.next !== null || row.text.startsWith("@@ "));
}

async function response<T>(request: Promise<Response>): Promise<T> {
  const result = await request;
  const body = await result.json();
  if (!result.ok) throw new Error(body.error ?? "Could not load review");
  return body;
}

export function GitReview({ agentId, reviewId, active, onQuote, onClose }: {
  agentId: string; reviewId: string; active: boolean; onQuote: (quote: DiffQuote) => void; onClose: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [file, setFile] = useState("");
  const [error, setError] = useState("");
  const [approving, setApproving] = useState(false);
  const loading = useRef<AbortController | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; start: number; end: number } | null>(null);
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/reviews/${encodeURIComponent(reviewId)}`;
  const snapshot = review?.snapshot;
  const rows = lines(snapshot?.files.find(item => item.path === file)?.patch ?? "");

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    loading.current = controller;
    response<Review>(fetch(endpoint, { signal: controller.signal, cache: "no-store" })).then(data => {
      setReview(data);
      setFile(current => data.snapshot.files.some(item => item.path === current) ? current : data.snapshot.files[0]?.path ?? "");
      setError("");
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [endpoint, active]);

  const approve = async () => {
    loading.current?.abort();
    setApproving(true);
    try {
      setReview(await response<Review>(fetch(`${endpoint}/approve`, { method: "POST" })));
      setError("");
    } catch (error) { setError(String(error)); }
    finally { setApproving(false); }
  };

  const quote = () => {
    if (!menu || !review || !snapshot) return;
    const selected = rows.slice(menu.start, menu.end + 1);
    const old = selected.flatMap(row => row.old === null ? [] : [row.old]);
    const next = selected.flatMap(row => row.next === null ? [] : [row.next]);
    const range = `old ${old.length ? `${old[0]}–${old.at(-1)}` : "none"}, new ${next.length ? `${next[0]}–${next.at(-1)}` : "none"}`;
    onQuote({ path: file, rows: selected, text: `Review ${review.id}: ${review.title}\n${snapshot.baseCommit}...${snapshot.headCommit}\nFile: ${file} (${range})\n\n${selected.map(row => `> ${row.text}`).join("\n")}\n\n` });
    setMenu(null);
  };

  return <section aria-label="Change review" className="flex min-h-0 flex-1 flex-col" onClick={() => setMenu(null)}>
    <div className="flex items-center gap-3 border-b border-rule px-4 py-2 text-[13px]">
      <button aria-label="Back to conversation" title="Back to conversation" onClick={onClose} className="cursor-pointer"><Icon name="back" /></button>
      <span className="min-w-0 flex-1 font-semibold">{review?.title ?? "Reading review…"}</span>
      {review && <>
        <span className="text-faint">{review.status === "approved" ? "Approved for publication" : review.status === "stale" ? "Revision changed" : "Awaiting approval"}</span>
        <button aria-label="Approve publication" title="Approve this revision for push and PR creation" onClick={approve}
          disabled={approving || review.status !== "pending"}
          className="cursor-pointer p-2 hover:bg-band disabled:cursor-default disabled:opacity-40"><Icon name="tick" /></button>
      </>}
    </div>
    {review && snapshot && <details className="border-b border-rule px-4 py-2 text-[12px]">
      <summary className="cursor-pointer break-all"><span className="ml-2">{snapshot.branch} <span className="text-faint">into</span> {snapshot.baseRef.replace("refs/heads/", "").replace("refs/remotes/", "")}</span></summary>
      <div className="mt-2 break-all text-faint">{snapshot.repository}<br />Publish to {snapshot.remoteUrl}<br />Base {snapshot.baseCommit.slice(0, 8)} · Head {snapshot.headCommit.slice(0, 8)}</div>
      <Markdown>{review.description}</Markdown>
    </details>}
    {error && <p role="alert" className="px-4 py-2 text-[12px]">{error}</p>}
    {review?.status === "stale" && <p className="px-4 py-2 text-[12px]">This snapshot is still readable. Ask the agent to present the revised change for fresh approval.</p>}
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Changed files" className="w-48 shrink-0 overflow-y-auto border-r border-rule text-[12px] max-sm:w-32">
        {snapshot?.files.map(item => <button key={item.path} title={item.path} onClick={() => setFile(item.path)} className={`block w-full cursor-pointer break-all px-3 py-2 text-left ${item.path === file ? "bg-band font-semibold" : "hover:bg-band"}`}>{item.path}</button>)}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-3 text-[12px]">
        {review && <>
          <p className="mb-3 text-faint">{file}</p>
          <pre data-diff className="w-max min-w-full font-mono leading-[1.6]" onContextMenu={event => {
            const clicked = (event.target as HTMLElement).closest<HTMLElement>("[data-diff-line]");
            if (!clicked) return;
            event.preventDefault();
            const selection = window.getSelection();
            const rowOf = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-diff-line]");
            const anchor = rowOf(selection?.anchorNode), focus = rowOf(selection?.focusNode);
            const selected = selection && !selection.isCollapsed && anchor?.closest("[data-diff]") === event.currentTarget && focus?.closest("[data-diff]") === event.currentTarget;
            const start = Number(selected ? anchor?.dataset.diffLine : clicked.dataset.diffLine);
            const end = Number(selected ? focus?.dataset.diffLine : clicked.dataset.diffLine);
            setMenu({ x: Math.min(event.clientX, window.innerWidth - 48), y: Math.min(event.clientY, window.innerHeight - 48), start: Math.min(start, end), end: Math.max(start, end) });
          }}>
            {rows.map((row, index) => <div key={index} data-diff-line={index} className={row.old === null && row.next === null ? "text-faint" : row.old === null ? "bg-ok/10 text-ok" : row.next === null ? "bg-remove/10 text-remove" : ""}><span className="mr-3 inline-block w-9 select-none text-right text-faint">{row.old}</span><span className="mr-3 inline-block w-9 select-none text-right text-faint">{row.next}</span><span>{row.text}</span></div>)}
          </pre>
        </>}
      </div>
    </div>
    {menu && <div role="group" aria-label="Diff actions" style={{ left: menu.x, top: menu.y }} className="fixed z-50 bg-card p-2 shadow-md">
      <button title="Quote diff into chat" aria-label="Quote diff into chat" onClick={quote} className="cursor-pointer"><Icon name="quote" /></button>
    </div>}
  </section>;
}
