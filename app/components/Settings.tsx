"use client";

import { useEffect } from "react";

import { type Graph, type Theme, type Verbose } from "../lib/keys";

const LOOK: { value: Theme; label: string; detail: string }[] = [
  { value: "light", label: "Light", detail: "Warm paper" },
  { value: "dark", label: "Dark", detail: "The same palette, read the other way round" },
];

const NOISE: { value: Verbose; label: string; detail: string }[] = [
  { value: "off", label: "Off", detail: "Every tool call behind its toggle" },
  { value: "on", label: "Verbose", detail: "The latest one stays in view" },
];

const SHAPE: { value: Graph; label: string; detail: string }[] = [
  { value: "off", label: "Off", detail: "The list alone" },
  { value: "on", label: "Flowchart", detail: "Draw what is waiting on what, above the list" },
];

const HINTS: { value: boolean; label: string; detail: string }[] = [
  { value: true, label: "On", detail: "Letters on the cards, and j k h l to move (v)" },
  { value: false, label: "Off", detail: "Typing only" },
];

/**
 * Everything there is to decide, which is not much on purpose.
 *
 * A setting is a question the interface could not answer for you; the rest
 * belongs in the interface itself.
 */
export function Settings({
  theme,
  onTheme,
  verbose,
  onVerbose,
  graph,
  onGraph,
  wrap,
  onWrap,
  vim,
  onVim,
  onClose,
}: {
  theme: Theme;
  onTheme: (next: Theme) => void;
  verbose: Verbose;
  onVerbose: (next: Verbose) => void;
  graph: Graph;
  onGraph: (next: Graph) => void;
  wrap: "off" | "on";
  onWrap: (next: "off" | "on") => void;
  vim: boolean;
  onVim: (next: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="settings"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="max-h-full w-full max-w-[420px] overflow-y-auto border border-edge bg-card px-6 py-5"
      >
        <p className="mb-4 text-[13px] font-semibold">Settings</p>
        <Choice
          title="Look"
          detail="Which way round the palette reads."
          options={LOOK}
          chosen={theme}
          onChoose={onTheme}
        />
        <Choice
          title="Tool calls"
          detail="How much of what an agent is doing you see."
          options={NOISE}
          chosen={verbose}
          onChoose={onVerbose}
        />
        <Choice
          title="Wrap code and diffs"
          detail="Fit long lines to the available width."
          options={[
            { value: "off", label: "Off", detail: "Scroll long lines horizontally" },
            { value: "on", label: "On", detail: "Wrap long lines" },
          ]}
          chosen={wrap}
          onChoose={onWrap}
        />
        <Choice
          title="Task list"
          detail="Whether blocked work is drawn as well as listed."
          options={SHAPE}
          chosen={graph}
          onChoose={onGraph}
        />
        <Choice
          title="Keyboard"
          detail="Whether the keys reach past what you are typing into."
          options={HINTS}
          chosen={vim}
          onChoose={onVim}
        />
      </div>
    </div>
  );
}

function Choice<T extends string | boolean>({
  title,
  detail,
  options,
  chosen,
  onChoose,
}: {
  title: string;
  detail: string;
  options: { value: T; label: string; detail: string }[];
  chosen: T;
  onChoose: (next: T) => void;
}) {
  return (
    <section className="mb-4 last:mb-0">
      <p className="text-[12.5px] font-semibold">{title}</p>
      <p className="mb-1 text-[11.5px] text-faint">{detail}</p>
      <div className="flex flex-col">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChoose(option.value)}
            aria-pressed={chosen === option.value}
            title={option.detail}
            className={[
              "flex cursor-pointer items-baseline gap-3 border-b border-hair px-2 py-[10px] text-left last:border-b-0",
              chosen === option.value ? "text-ink" : "text-mid hover:text-ink",
            ].join(" ")}
          >
            <span className="w-[14px] text-[12px]">{chosen === option.value ? "✓" : ""}</span>
            <span className="text-[12.5px] font-semibold">{option.label}</span>
            <span className="text-[11.5px] text-faint">{option.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
