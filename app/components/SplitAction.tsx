"use client";

import { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "./Icon";

export function SplitAction({
  label,
  hint,
  icon,
  onClick,
  disabled,
  menu,
  variant = "toolbar",
}: {
  label: string;
  /// The longer sentence, when the label alone does not explain it.
  hint?: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  menu: { label: string; icon: IconName; onClick: () => void }[];
  /// `quiet` is the composer button in a lighter weight: the same shape
  /// and size, for something that sits beside the box rather than ending
  /// the sentence.
  variant?: "toolbar" | "composer" | "quiet" | "strip";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className={`relative flex ${variant === "strip" ? "items-stretch" : ""}`}>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onClick();
        }}
        disabled={disabled}
        aria-label={label}
        title={hint ?? label}
        className={
          {
            composer: [
              "flex h-[34px] cursor-pointer items-center justify-center border-y border-l border-ink bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-40",
              menu.length > 0 ? "w-[32px]" : "w-[38px] border-r rounded-r-[3px]",
              "rounded-l-[3px]",
            ].join(" "),
            quiet: [
              "flex h-[34px] cursor-pointer items-center justify-center border-y border-l border-edge bg-card text-mid hover:text-ink rounded-l-[3px] disabled:cursor-not-allowed disabled:opacity-40",
              menu.length > 0 ? "w-[32px]" : "w-[38px] border-r rounded-r-[3px]",
            ].join(" "),
            strip:
              "flex w-[34px] cursor-pointer items-center justify-center text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
            toolbar:
              "flex h-8 w-8 cursor-pointer items-center justify-center rounded-l-[3px] border border-rule text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
          }[variant]
        }
      >
        <Icon name={icon} size={variant === "strip" ? 14 : 16} />
      </button>
      {menu.length > 0 && (
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-label={`${label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${label}: more ways`}
        className={
          {
            composer:
              "flex h-[34px] w-5 cursor-pointer items-center justify-center rounded-r-[3px] border-y border-r border-l border-l-paper/25 border-ink bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-40",
            quiet:
              "flex h-[34px] w-5 cursor-pointer items-center justify-center rounded-r-[3px] border-y border-r border-edge bg-card text-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
            strip:
              "flex w-[18px] cursor-pointer items-center justify-center border-r border-rule text-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
            toolbar:
              "flex h-8 w-6 cursor-pointer items-center justify-center rounded-r-[3px] border border-l-0 border-rule text-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
          }[variant]
        }
      >
        <Icon name="chevronDown" size={11} />
      </button>
      )}
      {open && (
        <div
          role="menu"
          // The composer sits on the bottom edge, so its menu opens upward;
          // below the button there is no screen left to draw it on.
          className={[
            "absolute right-0 z-30 min-w-max border border-rule bg-card p-1 shadow-[0_8px_24px_rgba(33,29,25,0.12)]",
            variant === "toolbar" ? "top-full mt-1" : "bottom-full mb-1",
          ].join(" ")}
        >
          {menu.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[12px] text-mid hover:bg-wash hover:text-ink"
            >
              <Icon name={item.icon} size={14} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
