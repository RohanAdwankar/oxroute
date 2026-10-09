"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
  const [menu, setMenu] = useState<{ x: number; y: number; file: string; start: number; end: number; wholeFile?: boolean } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/reviews/${encodeURIComponent(reviewId)}`;
  const snapshot = review?.snapshot;
  const files = useMemo(() => snapshot?.files.map(item => ({ ...item, rows: lines(item.patch) })) ?? [], [snapshot]);

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
      onClose();
    } catch (error) { setError(String(error)); }
    finally { setApproving(false); }
  };

  const quote = () => {
    if (!menu || !review || !snapshot) return;
    const selected = files.find(item => item.path === menu.file)!.rows.slice(menu.start, menu.end + 1);
    const old = selected.flatMap(row => row.old === null ? [] : [row.old]);
    const next = selected.flatMap(row => row.next === null ? [] : [row.next]);
    const range = menu.wholeFile ? "whole file" : `old ${old.length ? `${old[0]}–${old.at(-1)}` : "none"}, new ${next.length ? `${next[0]}–${next.at(-1)}` : "none"}`;
    onQuote({ path: menu.file, rows: selected, text: `Review ${review.id}: ${review.title}\n${snapshot.baseCommit}...${snapshot.headCommit}\nFile: ${menu.file} (${range})\n\n${selected.map(row => `> ${row.text}`).join("\n")}\n\n` });
    setMenu(null);
  };

  const quoteFile = (event: MouseEvent, item: { path: string; rows: Line[] }) => {
    event.preventDefault();
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 48), y: Math.min(event.clientY, window.innerHeight - 48), file: item.path, start: 0, end: item.rows.length - 1, wholeFile: true });
  };

  return <section aria-label="Change review" className="@container flex min-h-0 flex-1 flex-col" onClick={() => setMenu(null)}>
    <div className="flex items-center gap-3 border-b border-rule px-4 py-2 text-[13px]">
      <button aria-label="Back to conversation" title="Back to conversation" onClick={onClose} className="cursor-pointer"><Icon name="back" /></button>
      <span className="min-w-0 flex-1 font-semibold">{review?.title ?? (error ? "Review unavailable" : "Reading review…")}</span>
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
      <nav aria-label="Changed files" className="hidden w-36 shrink-0 overflow-y-auto border-r border-rule text-[10px] @min-[640px]:block">
        {files.map(item => <button key={item.path} title={item.path} onContextMenu={event => quoteFile(event, item)} onClick={() => {
          const section = sections.current.get(item.path), container = scroll.current;
          if (section && container) container.scrollTo({ top: section.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop });
          setFile(item.path);
        }} aria-current={item.path === file ? "location" : undefined} className={`block w-full cursor-pointer break-all px-2 py-2 text-left ${item.path === file ? "bg-band font-semibold" : "hover:bg-band"}`}>{item.path}</button>)}
      </nav>
      <div ref={scroll} className="min-w-0 flex-1 overflow-y-auto text-[12px]" onScroll={event => {
        const top = event.currentTarget.getBoundingClientRect().top;
        const current = files.find(item => (sections.current.get(item.path)?.getBoundingClientRect().bottom ?? 0) > top + 8);
        if (current) setFile(current.path);
      }}>
        {files.map(item => <section key={item.path} aria-label={`Diff ${item.path}`} ref={element => {
          if (element) sections.current.set(item.path, element);
          else sections.current.delete(item.path);
        }}>
          <h3 onContextMenu={event => quoteFile(event, item)} className="sticky top-0 z-10 bg-band px-3 py-1 text-[10px] text-mid">{item.path}</h3>
          <div className="overflow-x-auto px-3 py-1">
          <pre data-diff className="w-max min-w-full font-mono leading-[1.6]" onContextMenu={event => {
            const clicked = (event.target as HTMLElement).closest<HTMLElement>("[data-diff-line]");
            if (!clicked) return;
            event.preventDefault();
            const selection = window.getSelection();
            const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
            const rowOf = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-diff-line]");
            const anchor = rowOf(range?.startContainer), focus = rowOf(range?.endContainer);
            const selected = selection && !selection.isCollapsed && anchor?.closest("[data-diff]") === event.currentTarget && focus?.closest("[data-diff]") === event.currentTarget;
            const start = Number(selected ? anchor?.dataset.diffLine : clicked.dataset.diffLine);
            const end = Number(selected ? focus?.dataset.diffLine : clicked.dataset.diffLine) - (selected && range?.endOffset === 0 && anchor !== focus ? 1 : 0);
            setMenu({ x: Math.min(event.clientX, window.innerWidth - 48), y: Math.min(event.clientY, window.innerHeight - 48), file: item.path, start: Math.min(start, end), end: Math.max(start, end) });
          }}>
            {item.rows.map((row, index) => <div key={index} data-diff-line={index} className={row.old === null && row.next === null ? "text-faint" : row.old === null ? "bg-ok/10 text-ok" : row.next === null ? "bg-remove/10 text-remove" : ""}><span className="mr-3 inline-block w-9 select-none text-right text-faint">{row.old}</span><span className="mr-3 inline-block w-9 select-none text-right text-faint">{row.next}</span><span>{row.text}</span></div>)}
          </pre>
          </div>
        </section>)}
      </div>
    </div>
    {menu && <div role="group" aria-label="Diff actions" style={{ left: menu.x, top: menu.y }} className="fixed z-50 bg-card p-2 shadow-md">
      <button title={menu.wholeFile ? "Quote file into chat" : "Quote diff into chat"} aria-label={menu.wholeFile ? "Quote file into chat" : "Quote diff into chat"} onClick={quote} className="cursor-pointer"><Icon name="quote" /></button>
    </div>}
  </section>;
}
