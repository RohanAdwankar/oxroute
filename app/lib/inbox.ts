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

export const attention = (item:InboxItem) => item.state!=="waiting"?"routed":item.review?.state??(["slack-inbox","outlook-inbox"].includes(item.signal.source)?"unreviewed":"response_needed");
export const needsAttention = (item:InboxItem) => ["response_needed","unreviewed"].includes(attention(item));

export function inboxRows(items: InboxItem[], showDone: boolean): InboxRow[] {
  const waiting = items.filter(needsAttention);
  const done = items.filter(item=>!needsAttention(item));
  return [
    ...waiting.sort((a,b)=>Number(attention(b)==="response_needed")-Number(attention(a)==="response_needed")).map((item): InboxRow => ({ kind: "item", item })),
    ...(done.length > 0 ? [{ kind: "band", count: done.length } as InboxRow] : []),
    ...(showDone ? done.map((item): InboxRow => ({ kind: "item", item })) : []),
  ];
}
