"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";


type Point = { x: number; y: number };
type Shape =
  | { tool: "pen"; points: Point[] }
  | { tool: "box"; a: Point; b: Point }
  | { tool: "arrow"; a: Point; b: Point }
  | { tool: "text"; at: Point; text: string };
type Tool = Shape["tool"];

/** Marks are one red: on a screenshot, the thing that is not the page. */
const INK = "#d23c2e";
const BLANK = { width: 1600, height: 1000 };

const TOOLS: { tool: Tool; label: string }[] = [
  { tool: "pen", label: "Pen" },
  { tool: "box", label: "Box" },
  { tool: "arrow", label: "Arrow" },
  { tool: "text", label: "Text" },
];

export interface SketchHandle {
  /** The marked-up picture as a PNG, at the size of what was marked up. */
  export: () => Promise<File | null>;
  clear: () => void;
}

function paint(
  context: CanvasRenderingContext2D,
  size: { width: number; height: number },
  image: HTMLImageElement | null,
  shapes: Shape[],
) {
  context.fillStyle = "#fffdfa";
  context.fillRect(0, 0, size.width, size.height);
  if (image) context.drawImage(image, 0, 0, size.width, size.height);
  // A mark is read at whatever size the picture ends up: in a timeline, in
  // a thread, on a phone. It is drawn like a marker rather than a pen so it
  // survives being shrunk, and the arrowheads follow from it.
  const line = Math.max(7, size.width / 170);
  context.strokeStyle = INK;
  context.fillStyle = INK;
  context.lineWidth = line;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const shape of shapes) {
    context.beginPath();
    switch (shape.tool) {
      case "pen":
        shape.points.forEach((p, i) => (i === 0 ? context.moveTo(p.x, p.y) : context.lineTo(p.x, p.y)));
        context.stroke();
        break;
      case "box":
        context.strokeRect(
          Math.min(shape.a.x, shape.b.x),
          Math.min(shape.a.y, shape.b.y),
          Math.abs(shape.b.x - shape.a.x),
          Math.abs(shape.b.y - shape.a.y),
        );
        break;
      case "arrow": {
        const { a, b } = shape;
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const head = line * 5;
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
        context.beginPath();
        context.moveTo(b.x, b.y);
        context.lineTo(b.x - head * Math.cos(angle - 0.45), b.y - head * Math.sin(angle - 0.45));
        context.lineTo(b.x - head * Math.cos(angle + 0.45), b.y - head * Math.sin(angle + 0.45));
        context.closePath();
        context.fill();
        break;
      }
      case "text": {
        const font = Math.max(16, Math.round(size.width / 55));
        context.font = `600 ${font}px "IBM Plex Sans", system-ui, sans-serif`;
        const width = context.measureText(shape.text).width;
        const pad = font * 0.35;
        context.fillStyle = "rgba(255,253,250,0.92)";
        context.fillRect(shape.at.x - pad, shape.at.y - font - pad * 0.4, width + pad * 2, font + pad * 1.6);
        context.fillStyle = INK;
        context.fillText(shape.text, shape.at.x, shape.at.y);
        break;
      }
    }
  }
}

/**
 * Drawing a message instead of typing one: a screenshot, or a blank page,
 * with marks on it. For a frontend, a circle and an arrow say "this, there"
 * better than a paragraph does.
 *
 * It only composes a picture. Sending is the composer's, as an image
 * attached to whatever was typed, the same path a pasted image takes.
 */
export function Sketch({
  ref,
  onChange,
  say,
}: {
  ref?: Ref<SketchHandle>;
  onChange: (ready: boolean) => void;
  say: (text: string) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState(BLANK);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [drawing, setDrawing] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [typing, setTyping] = useState<{ at: Point; value: string } | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const scale =
    room.width > 0 ? Math.min((room.width - 32) / size.width, (room.height - 32) / size.height, 1) : 0.5;

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * scale * ratio);
    element.height = Math.round(size.height * scale * ratio);
    context.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
    paint(context, size, image, drawing ? [...shapes, drawing] : shapes);
  }, [size, scale, image, shapes, drawing]);

  useEffect(() => onChange(image !== null || shapes.length > 0), [image, shapes, onChange]);

  const load = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const next = new Image();
    next.onload = () => {
      setImage(next);
      setSize({ width: next.naturalWidth, height: next.naturalHeight });
      setShapes([]);
    };
    next.src = url;
  }, []);

  // A pasted screenshot is the fastest way in.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      load(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [load]);

  const capture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const frame = document.createElement("canvas");
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      frame.getContext("2d")?.drawImage(video, 0, 0);
      stream.getTracks().forEach((track) => track.stop());
      frame.toBlob((blob) => blob && load(blob), "image/png");
    } catch (error) {
      say(error instanceof Error ? error.message : "Could not capture the screen");
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      export: () =>
        new Promise<File | null>((resolve) => {
          if (!image && shapes.length === 0) return resolve(null);
          const out = document.createElement("canvas");
          out.width = size.width;
          out.height = size.height;
          const context = out.getContext("2d");
          if (!context) return resolve(null);
          paint(context, size, image, shapes);
          out.toBlob(
            (blob) => resolve(blob ? new File([blob], "sketch.png", { type: "image/png" }) : null),
            "image/png",
          );
        }),
      clear: () => {
        setImage(null);
        setSize(BLANK);
        setShapes([]);
      },
    }),
    [image, shapes, size],
  );

  const at = (event: React.PointerEvent): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
  };

  const commitText = () => {
    if (typing && typing.value.trim()) {
      setShapes((current) => [...current, { tool: "text", at: typing.at, text: typing.value.trim() }]);
    }
    setTyping(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair px-4 py-2">
        <ToolButton onClick={() => void capture()}>Screenshot</ToolButton>
        <ToolButton onClick={() => picker.current?.click()}>Image</ToolButton>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label="image to draw on"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) load(file);
            event.target.value = "";
          }}
        />
        <span className="mx-1 h-5 w-px bg-rule" />
        {TOOLS.map((option) => (
          <ToolButton key={option.tool} active={tool === option.tool} onClick={() => setTool(option.tool)}>
            {option.label}
          </ToolButton>
        ))}
        <span className="flex-1" />
        <ToolButton onClick={() => setShapes((current) => current.slice(0, -1))} disabled={shapes.length === 0}>
          Undo
        </ToolButton>
        <ToolButton
          onClick={() => {
            setShapes([]);
            setImage(null);
            setSize(BLANK);
          }}
          disabled={!image && shapes.length === 0}
        >
          Clear
        </ToolButton>
      </div>
      <div
        ref={area}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-paper"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          const file = Array.from(event.dataTransfer.files).find((f) => f.type.startsWith("image/"));
          if (!file) return;
          event.preventDefault();
          event.stopPropagation();
          load(file);
        }}
      >
        <div className="relative" style={{ width: size.width * scale, height: size.height * scale }}>
          <canvas
            ref={canvas}
            aria-label="sketch"
            className="block h-full w-full cursor-crosshair rounded-[3px] border border-rule"
            style={{ touchAction: "none" }}
            onPointerDown={(event) => {
              const point = at(event);
              if (tool === "text") {
                // The click would otherwise move focus to the page as it
                // lands, blurring the note field the moment it appears.
                event.preventDefault();
                commitText();
                setTyping({ at: point, value: "" });
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrawing(tool === "pen" ? { tool, points: [point] } : { tool, a: point, b: point });
            }}
            onPointerMove={(event) => {
              if (!drawing) return;
              const point = at(event);
              setDrawing((current) =>
                !current
                  ? current
                  : current.tool === "pen"
                    ? { ...current, points: [...current.points, point] }
                    : current.tool === "text"
                      ? current
                      : { ...current, b: point },
              );
            }}
            onPointerUp={() => {
              const done = drawing;
              setDrawing(null);
              if (!done) return;
              const big =
                done.tool === "pen"
                  ? done.points.length > 1
                  : done.tool === "text" || Math.hypot(done.b.x - done.a.x, done.b.y - done.a.y) > 6;
              if (big) setShapes((current) => [...current, done]);
            }}
          />
          {typing && (
            <input
              autoFocus
              value={typing.value}
              onChange={(event) => setTyping({ ...typing, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitText();
                }
                if (event.key === "Escape") setTyping(null);
              }}
              onBlur={commitText}
              aria-label="note on the picture"
              placeholder="Note"
              className="absolute border-b-2 border-[#d23c2e] bg-card/90 px-1 text-[14px] font-semibold text-[#d23c2e] outline-none"
              style={{ left: typing.at.x * scale, top: typing.at.y * scale - 22, minWidth: 140 }}
            />
          )}
          {!image && shapes.length === 0 && !drawing && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-[13px] text-faint">
              Paste or drop a screenshot, take one, or draw on the blank page.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolButton({
  onClick,
  active = false,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={[
        "cursor-pointer rounded-[3px] border px-[9px] py-[4px] text-[12px] disabled:cursor-default disabled:opacity-40",
        active ? "border-[#d23c2e] text-[#d23c2e]" : "border-rule text-mid hover:text-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

