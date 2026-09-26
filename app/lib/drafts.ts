/**
 * Half-written words, kept while you look at something else.
 *
 * A composer unmounts whenever the main column changes -- a board, the
 * fleet, another session -- and what you had typed went with it. It lives
 * out here instead, under the name of whatever you were typing to.
 */
const drafts = new Map<string, string>();

export function draftFor(who: string): string {
  return drafts.get(who) ?? "";
}

export function keepDraft(who: string, text: string): void {
  if (text) drafts.set(who, text);
  else drafts.delete(who);
}
