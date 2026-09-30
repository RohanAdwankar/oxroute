"use client";

import { useId, useState } from "react";

/** `stage:idea` reads as "stage idea": the key quiet, the value plain. */
export function TagChip({
  tag,
  onRemove,
  quiet = false,
}: {
  tag: string;
  onRemove?: () => void;
  quiet?: boolean;
}) {
  const at = tag.indexOf(":");
  const [key, value] = at < 0 ? [null, tag] : [tag.slice(0, at), tag.slice(at + 1)];
  return (
    <span
      className={[
        "group/tag inline-flex max-w-full items-center gap-[3px] rounded-[3px] border px-[6px] leading-[18px]",
        quiet ? "border-hair text-[10.5px] text-mid" : "border-rule text-[11px] text-ink",
      ].join(" ")}
    >
      {key && <span className="text-faint">{key}</span>}
      <span className="truncate">{value}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={`remove ${tag}`}
          title="Remove"
          className="cursor-pointer text-faint hover:text-ink"
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * A session's tags, editable. Typing `key:value` sets that key -- a session
 * is at one stage -- and a bare word is added beside the rest.
 */
export function TagEditor({
  tags,
  known,
  busy,
  onAdd,
  onRemove,
}: {
  tags: string[];
  /** Every tag in use, offered as you type. */
  known: string[];
  busy: boolean;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const list = useId();
  const commit = () => {
    const tag = draft.trim();
    if (tag) onAdd(tag);
    setDraft("");
  };
  return (
    <div className="flex w-full min-w-0 flex-nowrap items-center gap-[5px] overflow-hidden">
      {tags.map((tag) => (
        <TagChip key={tag} tag={tag} onRemove={busy ? undefined : () => onRemove(tag)} />
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            setDraft("");
            event.currentTarget.blur();
          }
        }}
        onBlur={commit}
        list={list}
        disabled={busy}
        placeholder="+ tag"
        aria-label="add a tag"
        className="min-w-0 w-[110px] flex-1 border-b border-transparent bg-transparent px-1 text-[11.5px] outline-none placeholder:text-faint focus:border-edge"
      />
      <datalist id={list}>
        {known
          .filter((tag) => !tags.includes(tag))
          .map((tag) => (
            <option key={tag} value={tag} />
          ))}
      </datalist>
    </div>
  );
}

/** What adding a typed tag means: set a key, or add a bare word. */
export function tagChange(tag: string): { set?: string[]; add?: string[] } {
  return tag.includes(":") ? { set: [tag] } : { add: [tag] };
}
