"use client";

import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type ImgHTMLAttributes} from "react";
import {createPortal} from "react-dom";
import {Icon} from "./Icon";
import {MarkupTools, MarkupInput, MARKUP_INK, type MarkupTool} from "./MarkupTools";

export const FileReviews = createContext<((url: string) => void) | null>(null);
const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const extensions = new Set([...imageExtensions, "pdf", "pptx", "txt", "md", "csv", "tsv", "json", "yaml", "yml", "log", "rs", "py", "js", "ts", "tsx", "html", "css", "sh", "toml", "xml"]);
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

export function ReviewImage({src, alt, ...props}: ImgHTMLAttributes<HTMLImageElement>) {
  const open = useContext(FileReviews);
  const interactive = open && typeof src === "string" && reviewable(src);
  // Keep the image itself focusable so linked Markdown images do not nest buttons.
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} src={src} alt={alt} role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined}
    title={interactive ? "Enlarge and annotate" : props.title} style={interactive ? {...props.style, cursor: "zoom-in"} : props.style}
    onClick={interactive ? event => {event.preventDefault(); event.stopPropagation(); open(src);} : props.onClick}
    onKeyDown={interactive ? event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); event.stopPropagation(); open(src);}} : props.onKeyDown} />;
}

type Point = [number, number];
type Annotation = {page: number; quote: string; region: [number, number, number, number] | null; strokes: Point[][]; comment?: string; labels?: {at: Point; text: string}[]};
const isMark = (note: Annotation) => note.quote === "Drawing" && (note.region !== null || note.strokes.length > 0 || !!note.labels?.length);
type Review = {agentId: string; id: string; name: string; extension: string; sha256: string; pages: number; text: string | null; status: string; feedback: string; annotations: Annotation[]};
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
  const [page, setPage] = useState(1), [tool, setTool] = useState<MarkupTool | "select">("select"), [busy, setBusy] = useState(false);
  const [size, setSize] = useState({width: 1100, height: 700});
  const [typing, setTyping] = useState<{at: Point; value: string} | null>(null);
  const [annotationState, setAnnotationState] = useState<{notes: Annotation[]; history: Annotation[][]; active: number | null}>({notes: [], history: [], active: null});
  const {notes, active} = annotationState;
  const setActive = useCallback((active: number | null) => setAnnotationState(current => ({...current, active})), []);
  const setNotes = useCallback((update: Annotation[] | ((notes: Annotation[]) => Annotation[])) => setAnnotationState(current => ({...current, notes: typeof update === "function" ? update(current.notes) : update})), []);
  const draw = tool !== "select";
  const [text, setText] = useState("");
  const [gesture, setGesture] = useState<Point[]>([]);
  const gesturePoints = useRef<Point[]>([]), drawingPointer = useRef<number | null>(null);
  const surface = useRef<SVGSVGElement>(null);
  const [menu, setMenu] = useState<{x: number; y: number; quote: string} | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
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
  }, [agent, url, setNotes]);
  useEffect(() => {if (review) sessionStorage.setItem(`oxroute.fileReview.${review.id}`, JSON.stringify({notes, text}));}, [review, notes, text]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      if (typing) setTyping(null); else if (menu) setMenu(null); else close();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [menu, typing, close]);
  const original = new URL(url, "http://localhost");
  const originalName = (original.searchParams.get("path") ?? decodeURIComponent(original.pathname)).split("/").at(-1) ?? "";
  const previewImage = reviewable(url) && imageExtensions.includes(originalName.split(".").at(-1)?.toLowerCase() ?? "");
  const isImage = review ? imageExtensions.includes(review.extension) : previewImage;
  const pageNotes = notes.filter(note => note.page === page);
  const point = useCallback((event: {clientX: number; clientY: number}): Point => {
    const bounds = surface.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))];
  }, []);
  const changeNotes = useCallback((update: Annotation[] | ((notes: Annotation[]) => Annotation[])) => setAnnotationState(current => ({...current, history: [...current.history, current.notes], notes: typeof update === "function" ? update(current.notes) : update})), []);
  const addComment = useCallback((note: Annotation) => {
    setAnnotationState(current => ({notes: [...current.notes, note], history: [...current.history, current.notes], active: current.notes.length})); setMenu(null);
    field.current?.focus();
  }, []);
  const mark = useCallback((strokes: Point[][] = [], labels: NonNullable<Annotation["labels"]> = []) => {
    changeNotes(current => {
      const index = current.findIndex(note => note.page === page && note.quote === "Drawing" && !note.region);
      return index < 0 ? [...current, {page, quote: "Drawing", region: null, strokes, labels}] : current.map((note, i) => i === index ? {...note, strokes: [...note.strokes, ...strokes], labels: [...(note.labels ?? []), ...labels]} : note);
    });
  }, [page, changeNotes]);
  function commitText() {if (typing?.value.trim()) mark([], [{at: typing.at, text: typing.value.trim()}]); setTyping(null);}
  function quote() {
    if (menu) addComment({page: review?.pages ? page : 0, quote: menu.quote, region: null, strokes: []});
  }
  const finish = useCallback((event: PointerEvent) => {
    if (drawingPointer.current !== event.pointerId) return;
    drawingPointer.current = null;
    const points = gesturePoints.current, end = point(event), start = points[0]; gesturePoints.current = []; setGesture([]);
    if (!start) return;
    const area: Annotation["region"] = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(start[0]-end[0]), Math.abs(start[1]-end[1])];
    if (tool === "select") {if (area[2] > .003 && area[3] > .003) addComment({page, quote: "Selected area", region: area, strokes: []});}
    else if (tool === "box") changeNotes(current => [...current, {page, quote: "Drawing", region: area, strokes: []}]);
    else if (tool === "arrow") {
      const {width, height} = size;
      const angle = Math.atan2((end[1]-start[1])*height, (end[0]-start[0])*width), head = Math.max(15, width*.02);
      const tip = (angle: number): Point => [Math.max(0, Math.min(1, end[0]-head*Math.cos(angle)/width)), Math.max(0, Math.min(1, end[1]-head*Math.sin(angle)/height))];
      mark([[start, end], [tip(angle-.45), end, tip(angle+.45)]]);
    } else mark([[...points, end]]);
  }, [point, tool, page, size, addComment, changeNotes, mark]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (drawingPointer.current !== event.pointerId || event.buttons === 0) return;
      const next = point(event);
      gesturePoints.current = tool === "pen" ? [...gesturePoints.current, next] : [gesturePoints.current[0], next];
      setGesture(gesturePoints.current);
    };
    const cancel = () => {drawingPointer.current = null; gesturePoints.current = []; setGesture([]);};
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel);};
  }, [tool, point, finish]);
  async function decide(status: "approved" | "changes_requested" | "replied") {
    if (!review) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("decision", JSON.stringify({status, text, annotations: notes, requestId: requestId.current}));
      for (const number of new Set(isImage ? [1] : notes.map(note => note.page).filter(Boolean))) {
        const picture = new Image(); picture.src = `${base}/pages/${number}`; await picture.decode();
        const canvas = document.createElement("canvas"); canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
        const context = canvas.getContext("2d")!; context.drawImage(picture, 0, 0); context.strokeStyle = MARKUP_INK; context.lineWidth = 3;
        for (const [index, note] of notes.entries()) {
          if (note.page !== number) continue;
          if (note.region) {const [x, y, w, h] = note.region; context.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height); if (note.quote !== "Drawing") {context.font = "600 20px system-ui"; context.fillStyle = MARKUP_INK; context.fillText(String(index+1), x*canvas.width+4, y*canvas.height+24);}}
          for (const stroke of note.strokes) {context.beginPath(); stroke.forEach(([x,y], i) => i ? context.lineTo(x * canvas.width, y * canvas.height) : context.moveTo(x * canvas.width, y * canvas.height)); context.stroke();}
          for (const label of note.labels ?? []) {const font = Math.max(16, Math.round(canvas.width/55)); context.font = `600 ${font}px system-ui, sans-serif`; context.fillStyle = MARKUP_INK; context.fillText(label.text, label.at[0]*canvas.width, label.at[1]*canvas.height);}
        }
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not capture annotation")), "image/png"));
        form.append("files", blob, `review-${review.id.slice(0, 12)}-page-${number}.png`);
      }
      const value = await response<Review>(fetch(`${base}/decision`, {method: "POST", body: form}));
      setReview(value); requestId.current = crypto.randomUUID(); sessionStorage.removeItem(`oxroute.fileReview.${review.id}`);
    } catch (reason) {setError(String(reason));} finally {setBusy(false);}
  }
  return <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={isImage ? "Image preview" : "File review"} className="fixed inset-0 z-[100] flex flex-col bg-paper text-ink" onKeyDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <header className="flex shrink-0 items-center gap-4 bg-band px-5 py-3 text-sm"><strong className="min-w-0 flex-1 truncate">{review?.name ?? (previewImage ? originalName : "Preparing file review…")}</strong>{review && <><span aria-live="polite">{review.status === "replied" ? "Reply sent" : isImage && review.status === "pending" ? "" : review.status.replaceAll("_", " ")}</span><a href={`${base}/original`} download={review.name} aria-label="Download original" title="Download original"><Icon name="attach" /></a></>}<button type="button" aria-label="Close file review" onClick={close} className="cursor-pointer px-2">×</button></header>
    {error && <p role="alert" className="px-5 py-2 text-hold">{error}</p>}
    {!review && previewImage && <div className="min-h-0 flex-1 overflow-auto p-5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Image preview" className="mx-auto block h-auto w-full max-w-[1100px]" />
    </div>}
    {review && <><div className="flex min-h-0 flex-1 flex-col md:flex-row"><main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {review.pages > 0 && <div className="flex shrink-0 items-center gap-4 px-5 py-2 text-xs">{!isImage && <><button disabled={page === 1} onClick={() => {setPage(page - 1);}}>Previous</button><span>Page {page} of {review.pages}</span><button disabled={page === review.pages} onClick={() => {setPage(page + 1);}}>Next</button></>}<MarkupTools select tool={tool} onTool={setTool} empty={!notes.some(note => note.page === page)}
        onUndo={() => setAnnotationState(current => {
          const previous = current.history.at(-1), index = current.notes.findLastIndex(note => note.page === page);
          return {active: null, history: current.history.slice(0,-1), notes: previous ?? current.notes.flatMap((note,i) => i !== index ? [note] : note.labels?.length ? [{...note,labels:note.labels.slice(0,-1)}] : note.strokes.length ? [{...note,strokes:note.strokes.slice(0,-1)}] : [])};
        })}
        onClear={() => {changeNotes(current => current.filter(note => note.page !== page)); setActive(null);}} />
        <span className="text-faint">{tool === "select" ? "Select an area to comment" : tool === "text" ? "Click to add text" : "Draw directly on the page"}</span></div>}
      <div className="min-h-0 flex-1 overflow-auto p-5" onClick={() => setMenu(null)}>
        {review.text !== null ? <pre className="whitespace-pre-wrap break-words font-mono text-sm" onContextMenu={event => {const selected = window.getSelection()?.toString(); if (selected) {event.preventDefault(); setMenu({x: event.clientX, y: event.clientY, quote: selected});}}}>{review.text}</pre> : <div className="relative mx-auto w-full max-w-[1100px] bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={page} src={`${base}/pages/${page}`} alt={`Document page ${page}`} onLoad={event => setSize({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})} className="block h-auto w-full" onError={() => setError("Could not render this page. Reopen the review to retry.")} />
          <svg ref={surface} aria-label="Document annotations" className="absolute inset-0 h-full w-full touch-none" viewBox="0 0 1 1" preserveAspectRatio="none" style={{cursor: tool === "text" ? "text" : draw ? "crosshair" : "default"}}
            onPointerDown={event => {if (event.button !== 0) return; if (tool === "text") {event.preventDefault(); commitText(); setTyping({at: point(event), value: ""}); return;} event.preventDefault(); drawingPointer.current = event.pointerId; gesturePoints.current = [point(event)]; setGesture(gesturePoints.current); setMenu(null);}}
            >

            {pageNotes.map((note, i) => <g key={i}>{note.region && <rect x={note.region[0]} y={note.region[1]} width={note.region[2]} height={note.region[3]} fill="transparent" stroke={MARKUP_INK} strokeWidth=".002" />}{note.strokes.map((stroke, j) => <polyline key={j} points={stroke.map(p => p.join(",")).join(" ")} fill="none" stroke={MARKUP_INK} strokeWidth=".002" />)}{[...(note.labels ?? []), ...(note.region && note.quote !== "Drawing" ? [{at: [note.region[0]+.004, Math.min(1,note.region[1]+.03)] as Point, text: String(notes.indexOf(note)+1)}] : [])].map((label,j) => <text key={`text-${j}`} transform={`translate(${label.at[0]} ${label.at[1]}) scale(${1/size.width} ${1/size.height})`} fill={MARKUP_INK} fontSize={Math.max(16, Math.round(size.width/55))} fontWeight="600">{label.text}</text>)}</g>)}

            {gesture.length > 1 && (tool === "pen" || tool === "arrow" ? <polyline points={gesture.map(p => p.join(",")).join(" ")} fill="none" stroke={MARKUP_INK} strokeWidth=".002" /> : <rect x={Math.min(gesture[0][0], gesture.at(-1)![0])} y={Math.min(gesture[0][1], gesture.at(-1)![1])} width={Math.abs(gesture[0][0]-gesture.at(-1)![0])} height={Math.abs(gesture[0][1]-gesture.at(-1)![1])} fill="#4b80b522" stroke="#4b80b5" strokeWidth=".002" />)}
          </svg>
          {typing && <MarkupInput value={typing.value} onChange={value => setTyping({...typing, value})} onCommit={commitText} onCancel={() => setTyping(null)} style={{left: `${typing.at[0]*100}%`, top: `${typing.at[1]*100}%`}} />}
        </div>}
      </div>
    </main><aside className="flex w-full shrink-0 flex-col gap-3 bg-band p-5 md:w-80"><button type="button" aria-label="General feedback" className="text-left text-sm" onClick={() => setActive(null)}>{active === null ? isImage ? "Reply" : "Review feedback" : "Comment on selection"}</button>
      <div className="max-h-52 overflow-auto text-xs">{notes.map((note, i) => !isMark(note) && <div key={i} className="mb-3 flex gap-2"><button className={`min-w-0 flex-1 text-left ${active === i ? "text-ink" : "text-mid"}`} onClick={() => {setActive(i); if (note.page) setPage(note.page); field.current?.focus();}}>{note.page ? `Page ${note.page}: ` : ""}{note.region ? `Selection ${i+1}` : note.quote}{note.comment && <span className="mt-1 block">{note.comment}</span>}</button><button aria-label={`Remove annotation ${i+1}`} onClick={() => {changeNotes(current => current.filter((_, n) => n !== i)); setActive(null);}}>×</button></div>)}</div>
      <textarea ref={field} aria-label={active === null ? "File review feedback" : "Selection comment"} placeholder={active !== null ? "Comment on this selection…" : isImage ? "Add a reply…" : "What should change?"} value={active === null ? text : notes[active]?.comment ?? ""} onChange={event => {const value=event.target.value; if (active === null) setText(value); else setNotes(current => current.map((note,i) => i === active ? {...note,comment:value} : note));}} className="min-h-36 w-full resize-y bg-paper p-3 text-sm outline-none" /><div className="flex justify-end gap-2">
      <button type="button" aria-label={isImage ? "Send image reply" : "Request revision"} title={busy ? "Sending" : isImage ? "Send reply" : "Request revision"} aria-busy={busy} disabled={busy || (!isImage && !text.trim() && !notes.some(note => note.comment?.trim()))} onClick={() => void decide(isImage ? "replied" : "changes_requested")} className="flex h-9 w-9 cursor-pointer items-center justify-center bg-paper disabled:opacity-40"><span className={busy ? "animate-spin" : ""}><Icon name={busy ? "refresh" : isImage ? "send" : "pen"} /></span></button>
      {!isImage && <button type="button" aria-label="Approve this version" title="Approve" aria-busy={busy} disabled={busy} onClick={() => void decide("approved")} className="flex h-9 w-9 cursor-pointer items-center justify-center bg-ink text-paper disabled:opacity-40"><Icon name="tick" /></button>}
    </div><p className="break-all text-[10px] text-faint" title={review.sha256}>Revision {review.sha256.slice(0, 12)}</p></aside></div></>}
    {menu && <button type="button" role="menuitem" className="fixed z-[110] cursor-pointer bg-ink px-4 py-2 text-sm text-paper" style={{left: Math.min(menu.x, window.innerWidth-210), top: Math.min(menu.y, window.innerHeight-50)}} onClick={quote}>Quote selected text</button>}
  </div>;
}
