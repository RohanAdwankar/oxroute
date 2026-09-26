"use client";

import { useEffect, useState } from "react";

import { draftFor, keepDraft } from "../lib/drafts";
import { SplitAction } from "./SplitAction";

/**
 * The box at the bottom of the fleet.
 *
 * The same shape as the composer inside a conversation, but there is no
 * one to say it to out here, so the words go on the task list and wait to
 * be handed to an agent.
 */
/// There is one of these, so it needs one name to be kept under.
const FLEET = "the fleet";

export function TaskComposer({
  busy,
  onTask,
}: {
  busy: boolean;
  onTask: (text: string) => void;
}) {
  const [draft, setDraft] = useState(() => draftFor(FLEET));

  useEffect(() => keepDraft(FLEET, draft), [draft]);

  const file = () => {
    const text = draft.trim();
    if (!text) return;
    onTask(text);
    setDraft("");
  };

  return (
    <footer className="flex shrink-0 items-stretch border-t border-rule bg-card">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter and tab do the same thing here: out on the fleet there is
          // no one to say it to, so filing it is the only thing to do.
          if ((event.key !== "Enter" && event.key !== "Tab") || event.shiftKey) return;
          event.preventDefault();
          file();
        }}
        rows={1}
        placeholder="Add to the task list"
        className="min-h-[var(--cell)] flex-1 resize-none overflow-y-hidden border-r border-rule bg-paper px-3 py-[8px] text-[var(--said)] leading-[1.35] outline-none placeholder:text-faint"
      />
      <SplitAction
        label="Add to the task list"
        hint="Add to the task list, for whoever picks it up"
        icon="tasks"
        onClick={file}
        disabled={busy || !draft.trim()}
        menu={[]}
        up
      />
    </footer>
  );
}
