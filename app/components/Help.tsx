"use client";

import { useEffect } from "react";

/**
 * Every key, on one sheet.
 *
 * The letters on the cards already say where a signal can go; this says
 * everything else, so the keyboard is learnable without reading the source.
 */
const KEYS: [string, string][] = [
  ["j k", "move down, up in the column you are in"],
  ["g G", "first, last"],
  ["h l", "column left, right: inbox, agents, tasks"],
  ["tab", "next column"],
  ["enter", "open the item, send it where it is ticked, or type to an agent"],
  ["a s f …", "jump to that agent, or send this signal to it"],
  ["space", "tick an agent, while routing"],
  ["n", "start a new agent for this signal"],
  ["d", "discard this signal"],
  ["f", "letters on everything; type one to go there"],
  ["i", "add something to the inbox"],
  ["m", "ask me first, or auto route"],
  ["v", "letters on, off"],
  ["esc", "back out of the agent, then the routing question"],
  ["?", "this sheet"],
];

export function Help({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="keys"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[420px] border border-edge bg-card px-6 py-5"
      >
        <p className="mb-4 text-[13px] font-semibold">Keys</p>
        <dl className="grid grid-cols-[86px_1fr] gap-x-4 gap-y-[9px]">
          {KEYS.map(([key, what]) => (
            <div key={key} className="contents">
              <dt className="tnum text-[11.5px] text-mid">{key}</dt>
              <dd className="text-[11.5px] leading-[1.4]">{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
