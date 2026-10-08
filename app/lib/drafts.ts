/**
 * Half-written words, kept while you look at something else.
 *
 * A composer unmounts whenever the main column changes -- a board, the
 * fleet, another session -- and what you had typed went with it. It lives
 * out here instead, under the name of whatever you were typing to.
 */
const drafts = new Map<string, string>();
export type DiffQuote = { text: string; path: string; rows: { text: string; old: number | null; next: number | null }[] };
const diffDrafts = new Map<string, DiffQuote[]>();

export function diffsFor(who: string): DiffQuote[] { return diffDrafts.get(who) ?? []; }
export function keepDiffs(who: string, diffs: DiffQuote[]): void {
  if (diffs.length) diffDrafts.set(who, diffs);
  else diffDrafts.delete(who);
}

export function draftFor(who: string): string {
  return drafts.get(who) ?? "";
}

export function keepDraft(who: string, text: string): void {
  if (text) drafts.set(who, text);
  else drafts.delete(who);
}
