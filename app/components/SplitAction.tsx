"use client";

import { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "./Icon";

export function SplitAction({
  label,
  icon,
  onClick,
  disabled,
  menu,
  variant = "toolbar",
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  menu: { label: string; icon: IconName; onClick: () => void }[];
  variant?: "toolbar" | "composer";
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
    <div ref={root} className="relative flex">
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onClick();
        }}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={variant === "composer"
          ? "flex h-[42px] w-[38px] cursor-pointer items-center justify-center rounded-l-[3px] border border-ink bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-40"
          : "flex h-8 w-8 cursor-pointer items-center justify-center rounded-l-[3px] border border-rule text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"}
      >
        <Icon name={icon} />
      </button>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-label={`${label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${label} options`}
        className={variant === "composer"
          ? "flex h-[42px] w-6 cursor-pointer items-center justify-center rounded-r-[3px] border border-l-paper/25 border-ink bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-40"
          : "flex h-8 w-6 cursor-pointer items-center justify-center rounded-r-[3px] border border-l-0 border-rule text-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"}
      >
        <Icon name="chevronDown" size={11} />
      </button>
      {open && (
        <div
          role="menu"
          // The composer sits on the bottom edge, so its menu opens upward;
          // below the button there is no screen left to draw it on.
          className={[
            "absolute right-0 z-30 min-w-max border border-rule bg-card p-1 shadow-[0_8px_24px_rgba(33,29,25,0.12)]",
            variant === "composer" ? "bottom-full mb-1" : "top-full mt-1",
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
