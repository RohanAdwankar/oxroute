"use client";

import { useEffect, useRef } from "react";
import type { Agent, TaskItem } from "../lib/types";

export function ArchiveAgent({ agent, tasks, error, onCancel, onArchive }: {
  agent: Agent;
  tasks: TaskItem[];
  onCancel: () => void;
  error: string;
  onArchive: (completeTasks: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const remaining = tasks.filter(task => task.status !== "complete").length;
  useEffect(() => { dialog.current?.showModal(); }, []);
  return (
    <dialog ref={dialog} aria-labelledby="archive-title" onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); onCancel(); }}
      className="m-auto w-[min(640px,calc(100%_-_32px))] border border-edge bg-card p-5 text-ink backdrop:bg-ink/20">
      <h2 id="archive-title" className="text-[15px] font-semibold">Archive {agent.name}?</h2>
      <p className="mt-2 text-[13px] text-mid">{tasks.length} associated task{tasks.length === 1 ? "" : "s"}{remaining ? ` · ${remaining} awaiting completion` : ""}</p>
      {tasks.length > 0 && <ul className="quiet-scroll my-4 max-h-[55vh] overflow-y-auto text-[13px]">
        {tasks.map(task => <li key={task.id} className="flex items-start gap-4 py-2">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{task.text}</span>
          <span className="shrink-0 text-[12px] text-faint">{task.status.replaceAll("_", " ")}</span>
        </li>)}
      </ul>}
      {error && <p role="alert" className="my-3 text-[13px] text-merge">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-3 text-[13px]">
        <button autoFocus onClick={onCancel} className="cursor-pointer px-2 py-2 text-mid">Cancel</button>
        <button onClick={() => onArchive(false)} className="cursor-pointer px-2 py-2">{tasks.length ? "Archive without changing tasks" : "Archive"}</button>
        {remaining > 0 && <button onClick={() => onArchive(true)} className="cursor-pointer bg-ink px-3 py-2 text-paper">Mark all complete and archive</button>}
      </div>
    </dialog>
  );
}
