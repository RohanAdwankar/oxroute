"use client";

import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {Icon} from "./Icon";

export const FileReviews = createContext<((url: string) => void) | null>(null);
const extensions = new Set(["pdf", "pptx", "txt", "md", "csv", "tsv", "json", "yaml", "yml", "log", "rs", "py", "js", "ts", "tsx", "html", "css", "sh", "toml", "xml"]);
export function savedReview(url: string) {return url.startsWith("/api/agents/") && url.split("/").length === 6 && url.split("/")[4] === "file-reviews";}
export function reviewable(url: string) {
  const parsed = new URL(url, "http://localhost");
  if (parsed.pathname !== "/api/artifacts" && !parsed.pathname.startsWith("/api/attachments/")) return false;
  const file = parsed.pathname === "/api/artifacts" ? parsed.searchParams.get("path") ?? "" : decodeURIComponent(parsed.pathname);
  return (parsed.pathname === "/api/artifacts" || parsed.pathname.startsWith("/api/attachments/")) && extensions.has(file.split(".").at(-1)?.toLowerCase() ?? "");
}
export function ReviewFileButton({url}: {url: string}) {
  const open = useContext(FileReviews);
  return open && reviewable(url) ? <button type="button" onClick={event => {event.stopPropagation(); open(url);}} className="cursor-pointer px-2 text-xs text-mid hover:text-ink" title="Review submitted file">Review</button> : null;
}

type Point = [number, number];
type Annotation = {page: number; quote: string; region: [number, number, number, number] | null; strokes: Point[][]};
type Review = {agentId: string; id: string; name: string; sha256: string; pages: number; text: string | null; status: string; feedback: string; annotations: Annotation[]};
async function response<T>(request: Promise<Response>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new Error(await result.text());
  return result.json();
}
export function FileReviewProvider({agent, children}: {agent: string; children: ReactNode}) {
  const [url, setUrl] = useState("");
  return <FileReviews.Provider value={setUrl}>{children}{url && createPortal(<FileReview key={url} agent={agent} url={url} close={() => setUrl("")} />, document.body)}</FileReviews.Provider>;
}

function FileReview({agent, url, close}: {agent: string; url: string; close: () => void}) {
  const [review, setReview] = useState<Review | null>(null), [error, setError] = useState("");
  const [page, setPage] = useState(1), [draw, setDraw] = useState(false), [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([]), [text, setText] = useState("");
  const [gesture, setGesture] = useState<Point[]>([]), [region, setRegion] = useState<Annotation["region"]>(null);
  const [menu, setMenu] = useState<{x: number; y: number; quote: string} | null>(null);
  const image = useRef<HTMLImageElement>(null), field = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const base = review ? `/api/agents/${encodeURIComponent(review.agentId)}/file-reviews/${review.id}` : "";
  useEffect(() => {
    const controller = new AbortController();
    const parsed = new URL(url, location.origin), attachment = parsed.pathname.startsWith("/api/attachments/");
    const path = attachment ? decodeURIComponent(parsed.pathname.slice("/api/attachments/".length)) : parsed.searchParams.get("path");
    response<Review>(savedReview(url) ? fetch(url, {signal: controller.signal}) : fetch(`/api/agents/${encodeURIComponent(agent)}/file-reviews`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({path, attachment}), signal: controller.signal})).then(value => {
      let draft: {notes: Annotation[]; text: string} | null = null;
      try {draft = JSON.parse(sessionStorage.getItem(`oxroute.fileReview.${value.id}`) ?? "null");} catch {}
      setReview(value); setNotes(draft?.notes ?? value.annotations); setText(draft?.text ?? value.feedback);
    }).catch(reason => {if (!controller.signal.aborted) setError(String(reason));});
    return () => controller.abort();
  }, [agent, url]);
  useEffect(() => {if (review) sessionStorage.setItem(`oxroute.fileReview.${review.id}`, JSON.stringify({notes, text}));}, [review, notes, text]);
  const pageNotes = notes.filter(note => note.page === page);
  function point(event: React.PointerEvent<SVGSVGElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))];
  }
  function quote() {
    if (!menu) return;
    setNotes(current => [...current, {page: review?.pages ? page : 0, quote: menu.quote, region, strokes: []}]);
    setRegion(null); setMenu(null); field.current?.focus();
  }
  async function decide(status: "approved" | "changes_requested") {
    if (!review) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("decision", JSON.stringify({status, text, annotations: notes, requestId: requestId.current}));
      for (const number of new Set(notes.map(note => note.page).filter(Boolean))) {
        const picture = new Image(); picture.src = `${base}/pages/${number}`; await picture.decode();
        const canvas = document.createElement("canvas"); canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
        const context = canvas.getContext("2d")!; context.drawImage(picture, 0, 0); context.strokeStyle = "#d74343"; context.lineWidth = 3;
        for (const note of notes.filter(note => note.page === number)) {
          if (note.region) {const [x, y, w, h] = note.region; context.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);}
          for (const stroke of note.strokes) {context.beginPath(); stroke.forEach(([x,y], i) => i ? context.lineTo(x * canvas.width, y * canvas.height) : context.moveTo(x * canvas.width, y * canvas.height)); context.stroke();}
        }
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not capture annotation")), "image/png"));
        form.append("files", blob, `review-${review.id.slice(0, 12)}-page-${number}.png`);
      }
      const value = await response<Review>(fetch(`${base}/decision`, {method: "POST", body: form}));
      setReview(value); requestId.current = crypto.randomUUID(); sessionStorage.removeItem(`oxroute.fileReview.${review.id}`);
    } catch (reason) {setError(String(reason));} finally {setBusy(false);}
  }
  return <div role="dialog" aria-modal="true" aria-label="File review" className="fixed inset-0 z-[100] flex flex-col bg-paper text-ink" onKeyDown={event => {event.stopPropagation(); if (event.key === "Escape") {if (menu) setMenu(null); else close();}}} onContextMenu={event => event.stopPropagation()}>
    <header className="flex shrink-0 items-center gap-4 bg-band px-5 py-3 text-sm"><strong className="min-w-0 flex-1 truncate">{review?.name ?? "Preparing file review…"}</strong>{review && <><span aria-live="polite">{review.status.replaceAll("_", " ")}</span><a href={`${base}/original`} download={review.name}>Download</a></>}<button type="button" aria-label="Close file review" onClick={close} className="cursor-pointer px-2">×</button></header>
    {error && <p role="alert" className="px-5 py-2 text-hold">{error}</p>}
    {review && <><div className="flex min-h-0 flex-1 flex-col md:flex-row"><main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {review.pages > 0 && <div className="flex shrink-0 items-center gap-4 px-5 py-2 text-xs"><button disabled={page === 1} onClick={() => {setPage(page - 1); setRegion(null);}}>Previous</button><span>Page {page} of {review.pages}</span><button disabled={page === review.pages} onClick={() => {setPage(page + 1); setRegion(null);}}>Next</button><button aria-pressed={!draw} onClick={() => setDraw(false)}>Select area</button><button aria-pressed={draw} onClick={() => setDraw(true)}>Draw</button><span className="text-faint">{draw ? "Draw directly on the page" : "Drag an area, then right-click to quote"}</span></div>}
      <div className="min-h-0 flex-1 overflow-auto p-5" onClick={() => setMenu(null)}>
        {review.text !== null ? <pre className="whitespace-pre-wrap break-words font-mono text-sm" onContextMenu={event => {const selected = window.getSelection()?.toString(); if (selected) {event.preventDefault(); setRegion(null); setMenu({x: event.clientX, y: event.clientY, quote: selected});}}}>{review.text}</pre> : <div className="relative mx-auto w-full max-w-[1100px] bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}<img ref={image} key={page} src={`${base}/pages/${page}`} alt={`Document page ${page}`} className="block h-auto w-full" onError={() => setError("Could not render this page. Reopen the review to retry.")} />
          <svg aria-label="Document annotations" className="absolute inset-0 h-full w-full touch-none" viewBox="0 0 1 1" preserveAspectRatio="none" style={{cursor: draw ? "crosshair" : "default"}}
            onPointerDown={event => {if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setGesture([point(event)]); setMenu(null);}}
            onPointerMove={event => {if (event.currentTarget.hasPointerCapture(event.pointerId)) {const next = point(event); setGesture(current => draw ? [...current, next] : [current[0], next]);}}}
            onPointerUp={event => {if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; event.currentTarget.releasePointerCapture(event.pointerId); const end = point(event), start = gesture[0]; if (start) {if (draw) setNotes(current => [...current, {page, quote: "Drawing", region: null, strokes: [[...gesture, end]]}]); else if (Math.abs(start[0]-end[0]) > .003 && Math.abs(start[1]-end[1]) > .003) setRegion([Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(start[0]-end[0]), Math.abs(start[1]-end[1])]);} setGesture([]);}}
            onPointerCancel={() => setGesture([])} onContextMenu={event => {if (region) {event.preventDefault(); setMenu({x: event.clientX, y: event.clientY, quote: `Selected area on page ${page}`});}}}>
            {pageNotes.map((note, i) => <g key={i}>{note.region && <rect x={note.region[0]} y={note.region[1]} width={note.region[2]} height={note.region[3]} fill="transparent" stroke="#d74343" strokeWidth=".002" />}{note.strokes.map((stroke, j) => <polyline key={j} points={stroke.map(p => p.join(",")).join(" ")} fill="none" stroke="#d74343" strokeWidth=".002" />)}</g>)}
            {region && <rect x={region[0]} y={region[1]} width={region[2]} height={region[3]} fill="#4b80b522" stroke="#4b80b5" strokeWidth=".002" />}
            {gesture.length > 1 && (draw ? <polyline points={gesture.map(p => p.join(",")).join(" ")} fill="none" stroke="#d74343" strokeWidth=".002" /> : <rect x={Math.min(gesture[0][0], gesture.at(-1)![0])} y={Math.min(gesture[0][1], gesture.at(-1)![1])} width={Math.abs(gesture[0][0]-gesture.at(-1)![0])} height={Math.abs(gesture[0][1]-gesture.at(-1)![1])} fill="#4b80b522" stroke="#4b80b5" strokeWidth=".002" />)}
          </svg>
        </div>}
      </div>
    </main><aside className="flex w-full shrink-0 flex-col gap-3 bg-band p-5 md:w-80"><p className="text-sm">Review feedback</p><div className="max-h-52 overflow-auto text-xs">{notes.map((note, i) => <div key={i} className="mb-3 flex gap-2"><button className="min-w-0 flex-1 text-left" onClick={() => {if (note.page) setPage(note.page);}}>{note.page ? `Page ${note.page}: ` : ""}{note.quote}</button><button aria-label={`Remove annotation ${i+1}`} onClick={() => setNotes(current => current.filter((_, n) => n !== i))}>×</button></div>)}</div><textarea ref={field} aria-label="File review feedback" placeholder="What should change?" value={text} onChange={event => setText(event.target.value)} className="min-h-36 w-full resize-y bg-paper p-3 text-sm outline-none" /><div className="flex justify-end gap-2">
      <button type="button" aria-label="Request revision" title={busy ? "Sending" : "Request revision"} aria-busy={busy} disabled={busy || !text.trim()} onClick={() => void decide("changes_requested")} className="flex h-9 w-9 cursor-pointer items-center justify-center bg-paper disabled:opacity-40"><span className={busy ? "animate-spin" : ""}><Icon name={busy ? "refresh" : "pen"} /></span></button>
      <button type="button" aria-label="Approve this version" title="Approve" aria-busy={busy} disabled={busy} onClick={() => void decide("approved")} className="flex h-9 w-9 cursor-pointer items-center justify-center bg-ink text-paper disabled:opacity-40"><Icon name="tick" /></button>
    </div><p className="break-all text-[10px] text-faint" title={review.sha256}>Revision {review.sha256.slice(0, 12)}</p></aside></div></>}
    {menu && <button type="button" role="menuitem" className="fixed z-[110] cursor-pointer bg-ink px-4 py-2 text-sm text-paper" style={{left: Math.min(menu.x, window.innerWidth-210), top: Math.min(menu.y, window.innerHeight-50)}} onClick={quote}>{review?.pages ? "Quote selected area" : "Quote selected text"}</button>}
  </div>;
}
