import type { InboxItem } from "./types";

/**
 * The inbox column as rows, in the order it is drawn.
 *
 * The band over the settled items is a row like any other, so the cursor
 * can land on it and open it; otherwise the keyboard would walk through
 * items that are not on screen.
 */
export type InboxRow =
  | { kind: "item"; item: InboxItem }
  | { kind: "band"; count: number };

export function inboxRows(items: InboxItem[], showDone: boolean): InboxRow[] {
  const waiting = items.filter((item) => item.state === "waiting");
  const done = items.filter((item) => item.state !== "waiting");
  return [
    ...waiting.map((item): InboxRow => ({ kind: "item", item })),
    ...(done.length > 0 ? [{ kind: "band", count: done.length } as InboxRow] : []),
    ...(showDone ? done.map((item): InboxRow => ({ kind: "item", item })) : []),
  ];
}
