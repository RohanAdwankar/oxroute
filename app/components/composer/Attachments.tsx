"use client";

import type { Upload } from "../../lib/uploads";
import {useState} from "react";
import {DraftImageReview} from "../FileReview";

/**
 * The files waiting to go with what you are typing, and anything wrong
 * with them. Every composer shows them the same way.
 */
export function Attachments({
  uploads,
  error,
  dragging,
  onDrop,
  onReplace,
  onNote,
}: {
  uploads: Upload[];
  error: string;
  dragging: boolean;
  onDrop: (upload: Upload) => void;
  onReplace: (upload: Upload, file: File) => void;
  onNote: (text: string) => void;
}) {
  const [editing, setEditing] = useState<Upload | null>(null);
  return (
    <>
      {editing && <DraftImageReview file={editing.file} url={editing.preview} close={() => setEditing(null)} apply={(file, text) => {onReplace(editing, file); if (text) onNote(text);}} />}
      {dragging && (
        <p className="px-[var(--pane-x)] pt-[6px] text-[11px] text-drop">Drop files to attach</p>
      )}
      {uploads.length > 0 && (
        <div data-uploads className="flex flex-wrap gap-2 px-[var(--pane-x)] pt-[6px]">
          {uploads.map((upload) => (
            <span
              key={upload.preview}
              className="flex items-center gap-2 bg-band p-2 text-[11px] text-mid"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {upload.file.type.startsWith("image/") && <button type="button" aria-label={`Annotate ${upload.file.name}`} title="Enlarge and annotate" onClick={() => setEditing(upload)} onKeyDown={event => {if (event.key === "Enter" || event.key === " ") event.stopPropagation();}} className="cursor-zoom-in"><img src={upload.preview} alt="" className="h-10 w-10 object-cover" /></button>}
              <span className="max-w-48 truncate">{upload.file.name}</span>
              <button
                type="button"
                aria-label={`remove ${upload.file.name}`}
                title={`Remove ${upload.file.name}`}
                onClick={() => onDrop(upload)}
                className="cursor-pointer px-1 text-faint hover:text-ink"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="px-[var(--pane-x)] pt-[6px] text-[11px] text-hold">{error}</p>}
    </>
  );
}
