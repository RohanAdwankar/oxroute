"use client";

import { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "./Icon";

/**
 * A square that does one thing, with a chevron for the other ways to do it.
 *
 * It is the same square as everything else in a bar: no chip, no fill, no
 * corner. What it does is on hover, because an icon alone does not say.
 */
export function SplitAction({
  label,
  hint,
  icon,
  onClick,
  disabled,
  menu,
  up = false,
}: {
  label: string;
  /// The longer sentence, when the label alone does not explain it.
  hint?: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  menu: { label: string; icon: IconName; onClick: () => void }[];
  /// Whether the menu opens upward, for a square sitting on the bottom
  /// edge where there is no screen left below it.
  up?: boolean;
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
    <div ref={root} className="relative flex items-stretch">
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onClick();
        }}
        disabled={disabled}
        aria-label={label}
        title={hint ?? label}
        className="flex h-[var(--cell)] w-[var(--cell)] cursor-pointer items-center justify-center text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name={icon} size={14} />
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
          className="flex h-[var(--cell)] w-[18px] cursor-pointer items-center justify-center text-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="chevronDown" size={11} />
        </button>
      )}
      {open && (
        <div
          role="menu"
          className={[
            "absolute right-0 z-30 min-w-max border border-rule bg-card p-1 shadow-[0_8px_24px_rgba(33,29,25,0.12)]",
            up ? "bottom-full mb-1" : "top-full mt-1",
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
