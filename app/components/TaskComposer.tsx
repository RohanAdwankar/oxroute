"use client";

import { useEffect, useRef, useState } from "react";

import { draftFor, keepDraft } from "../lib/drafts";
import { acceptsImageDrop, useUploads } from "../lib/uploads";
import { Attachments } from "./composer/Attachments";
import { SplitAction } from "./SplitAction";

/// There is one of these, so it needs one name to be kept under.
const FLEET = "the fleet";

/**
 * The box at the bottom of the fleet.
 *
 * The same box as the one inside a conversation -- paste a screenshot into
 * it, drop one on it, pick one with the clip -- but there is no one to say
 * it to out here, so the words and the pictures go on the task list.
 */
export function TaskComposer({
  busy,
  onTask,
}: {
  busy: boolean;
  onTask: (text: string, images: File[]) => void;
}) {
  const [draft, setDraft] = useState(() => draftFor(FLEET));
  const [dragging, setDragging] = useState(false);
  const pictures = useUploads();
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => keepDraft(FLEET, draft), [draft]);

  const file = () => {
    const text = draft.trim();
    if (!text && pictures.uploads.length === 0) return;
    onTask(text, pictures.files);
    setDraft("");
    pictures.clear();
  };

  return (
    <footer
      onDragOver={(event) => {
        if (!acceptsImageDrop(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!acceptsImageDrop(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(false);
        void pictures.addFromDrop(event.dataTransfer);
      }}
      className={`flex shrink-0 flex-col border-t ${
        dragging ? "border-drop bg-wash" : "border-rule bg-card"
      }`}
    >
      <Attachments
        uploads={pictures.uploads}
        error={pictures.error}
        dragging={dragging}
        onDrop={pictures.drop}
      />
      <div className="flex items-stretch">
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            pictures.add(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <SplitAction
          label="Attach images"
          icon="attach"
          onClick={() => picker.current?.click()}
          disabled={busy}
          menu={[]}
          from="left"
          up
        />
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            pictures.add(files);
          }}
          onKeyDown={(event) => {
            // Enter and tab do the same thing here: out on the fleet there is
            // no one to say it to, so filing it is the only thing to do.
            if ((event.key !== "Enter" && event.key !== "Tab") || event.shiftKey) return;
            event.preventDefault();
            file();
          }}
          rows={1}
          placeholder="Add to the task list"
          className="min-h-[var(--cell)] flex-1 resize-none overflow-y-hidden border-x border-rule bg-paper px-3 py-[8px] text-[var(--said)] leading-[1.35] outline-none placeholder:text-faint"
        />
        <SplitAction
          label="Add to the task list"
          hint="Add to the task list, for whoever picks it up"
          icon="tasks"
          onClick={file}
          disabled={busy || (!draft.trim() && pictures.uploads.length === 0)}
          menu={[]}
          up
        />
      </div>
    </footer>
  );
}
