"use client";

import { useState } from "react";

import { SplitAction } from "./SplitAction";

/**
 * The box at the bottom of the fleet.
 *
 * The same shape as the composer inside a conversation, but there is no
 * one to say it to out here, so the words go on the task list and wait to
 * be handed to an agent.
 */
export function TaskComposer({
  busy,
  onTask,
}: {
  busy: boolean;
  onTask: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const file = () => {
    const text = draft.trim();
    if (!text) return;
    onTask(text);
    setDraft("");
  };

  return (
    <footer className="flex shrink-0 items-end gap-[6px] border-t border-rule bg-card px-[var(--pane-x)] py-[var(--row-y)]">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          file();
        }}
        rows={1}
        placeholder="Add to the task list"
        className="min-h-[var(--field)] flex-1 resize-none overflow-y-hidden rounded-[3px] border border-rule bg-paper px-3 py-[6px] text-[var(--said)] leading-[1.35] outline-none placeholder:text-faint focus:border-edge"
      />
      <SplitAction
        label="Add to the task list"
        hint="Add to the task list, for whoever picks it up"
        icon="tasks"
        onClick={file}
        disabled={busy || !draft.trim()}
        menu={[]}
        variant="composer"
      />
    </footer>
  );
}
