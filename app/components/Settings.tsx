"use client";

import { useEffect } from "react";

import { type Density } from "../lib/keys";

const ROOM: { value: Density; label: string; detail: string }[] = [
  { value: "compact", label: "Compact", detail: "For a small screen, or a large zoom" },
  { value: "wide", label: "Wide", detail: "More air around everything" },
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
  density,
  onDensity,
  vim,
  onVim,
  onClose,
}: {
  density: Density;
  onDensity: (next: Density) => void;
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
        className="w-full max-w-[420px] border border-edge bg-card px-6 py-5"
      >
        <p className="mb-4 text-[13px] font-semibold">Settings</p>
        <Choice
          title="Room"
          detail="How much room the interface takes."
          options={ROOM}
          chosen={density}
          onChoose={onDensity}
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
