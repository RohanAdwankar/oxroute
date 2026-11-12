"use client";

import { ReviewEditor } from "./ReviewEditor";
import { diffCode } from "./DiffCode";
import { cachedReview, loadReview, loadReviewImage, reviewEndpoint, type Review } from "../lib/reviews";

import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import type { DiffQuote } from "../lib/drafts";

type Line = { text: string; old: number | null; next: number | null };
type Expansion = { gap?: string; lines: string[]; more: boolean; busy?: boolean; error?: string };
type Context = { key: string; gap: string; old: number; next: number; limit: number; direction: "up" | "down"; side: "before" | "after" };

function hunkStart(header: string) {
  const ranges = header.split(" ").slice(1, 3).map(range => range.slice(1).split(",").map(Number));
  return { old: ranges[0][0] + (ranges[0][1] === 0 ? 1 : 0), next: ranges[1][0] + (ranges[1][1] === 0 ? 1 : 0) };
}

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

function ReviewImage({ endpoint, path, side, present, full }: { endpoint: string; path: string; side: "before" | "after"; present: boolean; full: boolean }) {
  const [failed, setFailed] = useState("");
  const label = side === "before" ? "Before" : "After";
  const url = `${endpoint}/image?${new URLSearchParams({ path, side, ...(full ? { full: "true" } : {}) })}`;
  const [image, setImage] = useState("");
  useEffect(() => {
    if (!present) return;
    let live = true, object = "";
    setImage("");
    loadReviewImage(url).then(blob => {
      if (live) { object = URL.createObjectURL(blob); setImage(object); setFailed(""); }
    }).catch(() => { if (live) setFailed(url); });
    return () => { live = false; if (object) URL.revokeObjectURL(object); };
  }, [url, present]);
  return <figure className="min-w-0 flex-1">
    <figcaption className="mb-2 text-[11px] text-faint">{label}</figcaption>
    {present ? <a href={url} target="_blank" rel="noreferrer" title={`Open ${side} image`}>
      {failed === url ? <span role="alert">Could not load image</span> :
        // eslint-disable-next-line @next/next/no-img-element
        image ? <img src={image} alt={`${label} ${path}`} onError={() => setFailed(url)} className="mx-auto max-h-96 max-w-full object-contain"
          style={{ backgroundImage: "repeating-conic-gradient(#8882 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }} /> : null}
    </a> : <div className="py-6 text-faint">{side === "before" ? "Added image" : "Deleted image"}</div>}
  </figure>;
}

export function GitReview({ agentId, reviewId, active, onQuote, onClose, onRevised }: {
  agentId: string; reviewId: string; active: boolean; onQuote: (quote: DiffQuote) => void; onClose: () => void; onRevised: (id: string) => void;
}) {
  const endpoint = reviewEndpoint(agentId, reviewId);
  const [full, setFull] = useState(false);
  const [review, setReview] = useState<Review | null>(() => cachedReview(endpoint) ?? null);
  const [file, setFile] = useState(() => cachedReview(endpoint)?.snapshot.files[0]?.path ?? "");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const cancelLoad = useRef<(() => void) | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; file: string; start: number; end: number; wholeFile?: boolean } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const snapshot = review?.snapshot;
  const expanding = useRef(new Set<string>());
  const [expanded, setExpanded] = useState<Record<string, Expansion>>({});
  const files = useMemo(() => snapshot?.files.map(item => {
    const original = lines(item.patch), rows: Line[] = [], controls = new Map<number, Context>();
    let old = 1, next = 1;
    const side = item.patch.split("\n").includes("+++ /dev/null") ? "before" : "after";
    const key = (direction: "up" | "down", old: number, next: number) => JSON.stringify([endpoint, review?.full, snapshot.headCommit, item.path, direction, old, next]);
    for (const [index, row] of original.entries()) {
      if (row.text.startsWith("@@ ")) {
        const start = hunkStart(row.text), up = key("up", start.old, start.next);
        const saved = expanded[up]?.lines ?? [];
        const limit = Math.min(start.old - old, start.next - next) - (expanded[key("down", old, next)]?.lines.length ?? 0);
        rows.push(row);
        if (limit > saved.length) controls.set(rows.length - 1, { key: up, gap: key("down", old, next), ...start, limit, direction: "up", side });
        rows.push(...saved.map((text, at) => ({ text: ` ${text}`, old: start.old - saved.length + at, next: start.next - saved.length + at })));
        ({ old, next } = start);
        continue;
      }
      if (row.old !== null) old = row.old + 1;
      if (row.next !== null) next = row.next + 1;
      rows.push(row);
      const following = original[index + 1];
      if (following && !following.text.startsWith("@@ ")) continue;
      const start = following ? hunkStart(following.text) : null;
      const limit = start ? Math.min(start.old - old, start.next - next) - (expanded[key("up", start.old, start.next)]?.lines.length ?? 0) : Infinity;
      const down = key("down", old, next), saved = expanded[down];
      rows.push(...(saved?.lines ?? []).map((text, at) => ({ text: ` ${text}`, old: old + at, next: next + at })));
      if (limit > (saved?.lines.length ?? 0) && saved?.more !== false) controls.set(rows.length - 1, { key: down, gap: down, old, next, limit, direction: "down", side });
    }
    return { ...item, rows, controls, code: diffCode(rows, item.path) };
  }) ?? [], [snapshot, expanded, endpoint, review?.full]);

  const expand = async (path: string, context: Context) => {
    const saved = expanded[context.key] ?? { lines: [], more: true };
    if (expanding.current.has(context.gap)) return;
    expanding.current.add(context.gap);
    setExpanded(current => ({ ...current, [context.key]: { ...saved, gap: context.gap, busy: true, error: "" } }));
    try {
      const count = Math.min(20, context.limit - saved.lines.length);
      const anchor = context.side === "before" ? context.old : context.next;
      const start = context.direction === "up" ? anchor - saved.lines.length - count : anchor + saved.lines.length;
      const query = new URLSearchParams({ path, side: context.side, start: String(start), count: String(count), ...(review?.full ? { full: "true" } : {}) });
      const more = await response<{ lines: string[]; more: boolean }>(fetch(`${endpoint}/context?${query}`));
      setExpanded(current => ({ ...current, [context.key]: { lines: context.direction === "up" ? [...more.lines, ...saved.lines] : [...saved.lines, ...more.lines], more: context.direction === "up" || more.more } }));
    } catch (error) {
      setExpanded(current => ({ ...current, [context.key]: { ...saved, error: String(error) } }));
    } finally { expanding.current.delete(context.gap); }
  };

  useEffect(() => {
    if (!active) return;
    let live = true, readable = false;
    cancelLoad.current = () => { live = false; };
    const show = (data: Review) => {
      if (!live) return;
      readable = true;
      setReview(data);
      setFile(current => data.snapshot.files.some(item => item.path === current) ? current : data.snapshot.files[0]?.path ?? "");
      setError("");
    };
    const url = `${endpoint}${full ? "?full=true" : ""}`;
    loadReview(url).then(data => {
      show(data);
      return loadReview(url, true).then(show);
    }).catch(error => {
      if (live) setError(readable
        ? `Could not refresh review status.${error instanceof TypeError ? "" : ` ${String(error)}`} Saved changes remain readable.`
        : String(error));
    });
    return () => { live = false; };
  }, [endpoint, active, full]);

  const approve = async () => {
    if (!review) return;
    cancelLoad.current?.();
    setApproving(true);
    try {
      setReview(await response<Review>(fetch(`${reviewEndpoint(review.agentId, review.id)}/approve`, { method: "POST" })));
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
    onQuote({ path: menu.file, rows: selected, text: `Review ${review.id}: ${review.title}\n${!review.full && snapshot.reviewBaseCommit ? snapshot.reviewBaseCommit : snapshot.baseCommit}...${snapshot.headCommit}\nFile: ${menu.file} (${range})\n\n${selected.map(row => `> ${row.text}`).join("\n")}\n\n` });
    setMenu(null);
  };

  const quoteFile = (event: MouseEvent, item: { path: string; rows: Line[] }) => {
    event.preventDefault();
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 48), y: Math.min(event.clientY, window.innerHeight - 48), file: item.path, start: 0, end: item.rows.length - 1, wholeFile: true });
  };

  return <section aria-label="Change review" className="@container flex min-h-0 flex-1 flex-col" onClick={() => setMenu(null)}>
    <div className="flex items-center gap-3 border-b border-rule px-4 py-2 text-[13px]">
      <button aria-label="Back to conversation" title="Back to conversation" onClick={onClose} className="cursor-pointer"><Icon name="back" /></button>
      <span className="min-w-0 flex-1 font-semibold">{review?.title ?? (error ? "Review unavailable" : "Reading review…")}
        {review?.status === "stale" && <button type="button" aria-label="Snapshot changed"
          title={review.staleNotified ? "The agent has been asked to prepare an updated review. This saved snapshot remains readable." : "This snapshot no longer matches the repository or publication target. A fresh snapshot is needed for approval."}
          className="ml-2 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-hold align-middle text-[11px] font-normal text-hold">!</button>}
      </span>
      {review && <>
        {snapshot?.reviewBaseCommit && <button className="cursor-pointer text-faint hover:text-ink" title={full ? "Show only changes since the previous approval" : "Show the complete PR diff"}
          onClick={() => { setMenu(null); setReview(null); setFull(!full); }}>{full ? "Full PR" : "Since approval"}</button>}
        <span className="text-faint">{review.status === "approved" ? "Approved for publication" : review.status === "stale" ? review.staleNotified ? "Update requested" : "Revision changed" : "Awaiting approval"}</span>
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
    {review && !files.length && <p className="px-4 py-2 text-[12px] text-faint">No changes in this comparison.</p>}
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Changed files" className="hidden w-36 shrink-0 overflow-y-auto border-r border-rule text-[10px] @min-[640px]:block">
        {files.map(item => <button key={item.path} title={item.path} onContextMenu={event => quoteFile(event, item)} onClick={() => {
          const section = sections.current.get(item.path), container = scroll.current;
          if (section && container) {
            const bounds = container.getBoundingClientRect(), scale = bounds.height / parseFloat(getComputedStyle(container).height);
            container.scrollTo({ top: (section.getBoundingClientRect().top - bounds.top) / scale + container.scrollTop });
          }
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
          <h3 aria-label={item.path} onContextMenu={event => quoteFile(event, item)} className="sticky top-0 z-10 flex items-center gap-2 bg-band px-3 py-1 text-[10px] text-mid"><span className="min-w-0 flex-1 truncate">{item.path}</span><button type="button" aria-label={`Edit ${item.path}`} title="Edit file" onClick={() => setEditing(item.path)} className="cursor-pointer p-1"><Icon name="pen" size={14} /></button></h3>
          {item.image && <div aria-label={`Image comparison ${item.path}`} className="flex gap-4 bg-band/30 p-4">
            <ReviewImage endpoint={endpoint} path={item.path} side="before" present={item.image.before} full={!!review?.full} />
            <ReviewImage endpoint={endpoint} path={item.path} side="after" present={item.image.after} full={!!review?.full} />
          </div>}
          <div className="overflow-x-auto px-3 py-1">
          <pre data-diff className="w-max min-w-full font-mono leading-[1.6]" onContextMenu={event => {
            const clicked = (event.target as HTMLElement).closest<HTMLElement>("[data-diff-line]");
            if (!clicked) return;
            event.preventDefault();
            const selection = window.getSelection();
            const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
            const selected = range && !selection?.isCollapsed ? Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-diff-line]")).filter(row => {
              const code = row.lastElementChild!;
              if (!range.intersectsNode(code)) return false;
              const content = document.createRange(), overlap = range.cloneRange();
              content.selectNodeContents(code);
              if (overlap.compareBoundaryPoints(Range.START_TO_START, content) < 0) overlap.setStart(content.startContainer, content.startOffset);
              if (overlap.compareBoundaryPoints(Range.END_TO_END, content) > 0) overlap.setEnd(content.endContainer, content.endOffset);
              return overlap.toString().length > 0;
            }) : [];
            const start = Number((selected[0] ?? clicked).dataset.diffLine);
            const end = Number((selected.at(-1) ?? clicked).dataset.diffLine);
            setMenu({ x: Math.min(event.clientX, window.innerWidth - 48), y: Math.min(event.clientY, window.innerHeight - 48), file: item.path, start: Math.min(start, end), end: Math.max(start, end) });
          }}>
            {item.rows.map((row, index) => {
              const context = item.controls.get(index), status = context ? expanded[context.key] : undefined;
              return <Fragment key={`${row.old}:${row.next}:${row.text}`}><div data-diff-line={index} className={row.old === null && row.next === null ? "text-faint" : row.old === null ? "bg-ok/10 text-ok" : row.next === null ? "bg-remove/10 text-remove" : ""}><span className="mr-3 inline-block w-9 select-none text-right text-faint">{row.old}</span><span className="mr-3 inline-block w-9 select-none text-right text-faint">{row.next}</span><span>{item.code[index]}</span></div>
              {context && <div className="sticky left-0 w-fit py-1 font-sans text-[11px] text-mid">
                <button type="button" aria-label={status?.error ? "Retry expansion" : `Expand ${context.direction}`} title={status?.error ? "Retry expansion" : `Expand ${context.direction}`} aria-busy={!!status?.busy} disabled={Object.values(expanded).some(value => value.gap === context.gap && value.busy)} className="cursor-pointer px-2 py-1 hover:bg-band disabled:opacity-40"
                  onClick={() => void expand(item.path, context)}><span className={status?.busy ? "inline-block animate-spin" : context.direction === "up" ? "inline-block rotate-180" : "inline-block"}><Icon name={status?.busy ? "refresh" : "chevronDown"} size={14} /></span></button>
                {status?.error && <span role="alert">{status?.error}</span>}
              </div>}
            </Fragment>; })}
          </pre>
          </div>
        </section>)}
      </div>
    </div>
    {editing && snapshot && <ReviewEditor key={editing} endpoint={endpoint} path={editing} head={snapshot.headCommit} onClose={() => setEditing(null)} onSaved={revised => onRevised(revised.id)} />}
    {menu && <div role="group" aria-label="Diff actions" style={{ left: menu.x, top: menu.y }} className="fixed z-50 bg-card p-2 shadow-md">
      <button title={menu.wholeFile ? "Quote file into chat" : "Quote diff into chat"} aria-label={menu.wholeFile ? "Quote file into chat" : "Quote diff into chat"} onClick={quote} className="cursor-pointer"><Icon name="quote" /></button>
    </div>}
  </section>;
}
