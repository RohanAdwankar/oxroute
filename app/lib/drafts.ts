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
const fileDrafts = new Map<string, File[]>();
export const DRAFT_CHANGED = "oxroute.draftChanged";
export type ComposerDraft = { text: string; diffs: DiffQuote[]; files: File[] };
export const filesFor = (who: string): File[] => fileDrafts.get(who) ?? [];
export const keepFiles = (who: string, files: File[]): void => { if (files.length) fileDrafts.set(who, files); else fileDrafts.delete(who); };
export const composerDraft = (who: string): ComposerDraft => ({ text: draftFor(who), diffs: diffsFor(who), files: filesFor(who) });

export function receiveDraft(who: string, draft: ComposerDraft): void {
  const current = composerDraft(who);
  keepDraft(who, current.text && draft.text && current.text !== draft.text ? `${current.text}\n\n${draft.text}` : current.text || draft.text);
  keepDiffs(who, [...new Map([...current.diffs, ...draft.diffs].map(diff => [JSON.stringify(diff), diff])).values()]);
  keepFiles(who, [...current.files, ...draft.files]);
  window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, { detail: who }));
}

export function clearDraft(who: string): void {
  keepDraft(who, ""); keepDiffs(who, []); keepFiles(who, []);
  window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, { detail: who }));
}

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
