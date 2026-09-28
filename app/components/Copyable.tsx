"use client";

import { useRef, useState } from "react";

import { Icon } from "./Icon";

/**
 * A block of code with a way to take it.
 *
 * What is copied is read off the screen rather than passed in, so one
 * wrapper serves a fence in a message and the output of a command without
 * either of them having to hand their text over.
 */
export function Copyable({ children }: { children: React.ReactNode }) {
  const block = useRef<HTMLDivElement>(null);
  const [taken, setTaken] = useState(false);

  return (
    <div ref={block} className="group/copy relative">
      {children}
      <button
        type="button"
        aria-label={taken ? "copied" : "copy"}
        title={taken ? "Copied" : "Copy"}
        onClick={async () => {
          const text = block.current?.innerText ?? "";
          await navigator.clipboard.writeText(text);
          setTaken(true);
          window.setTimeout(() => setTaken(false), 1200);
        }}
        className="absolute top-1 right-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-[3px] border border-rule bg-card text-faint opacity-0 transition-opacity group-hover/copy:opacity-100 hover:text-ink focus:opacity-100"
      >
        <Icon name={taken ? "tick" : "copy"} size={12} />
      </button>
    </div>
  );
}
