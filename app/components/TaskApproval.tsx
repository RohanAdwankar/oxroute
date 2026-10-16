import type { TaskItem } from "../lib/types";

export function TaskApproval({ task, busy, approve, correct }: {
  task: TaskItem;
  busy: boolean;
  approve: () => void;
  correct: () => void;
}) {
  if (task.status !== "done") return null;
  return <span className="inline-flex items-center gap-2">
    <button type="button" disabled={busy} onClick={approve}
      className="cursor-pointer bg-ink px-2 py-1 text-[11.5px] text-paper disabled:opacity-40">Approve</button>
    <button type="button" disabled={busy} onClick={correct}
      className="cursor-pointer px-1 py-1 text-[11.5px] text-mid hover:text-ink disabled:opacity-40">Not yet</button>
  </span>;
}
