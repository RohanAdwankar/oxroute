"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Letters on everything, the way Vimium does it.
 *
 * The rest of the interface asks you to remember which key means which
 * place. This asks nothing: press f, and every button, row and card on
 * screen wears the letter that activates it. It reads the screen rather than
 * a list of targets, so a control added anywhere is reachable the day it is
 * added.
 */
// Every letter, home row first: while the letters are up they are the only
// keys the page listens to, so none of them has to be kept free.
const ALPHABET = "asdfghjklqwertyuiopzxcvbnm".split("");

const REACHABLE = [
  "a[href]",
  "button:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  '[role="menuitem"]',
].join(",");

type Target = { el: HTMLElement; label: string; top: number; left: number };

/** As many labels as there are targets, the shortest that will cover them. */
function labels(count: number): string[] {
  if (count <= ALPHABET.length) return ALPHABET.slice(0, count);
  const pairs: string[] = [];
  for (const first of ALPHABET) {
    for (const second of ALPHABET) {
      pairs.push(first + second);
      if (pairs.length === count) return pairs;
    }
  }
  return pairs;
}

function collect(): Target[] {
  const seen = [...document.querySelectorAll<HTMLElement>(REACHABLE)].filter((el) => {
    if (el.closest("[data-jump]")) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.bottom < 0 || rect.right < 0) return false;
    if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
    return getComputedStyle(el).visibility !== "hidden";
  });
  const keys = labels(seen.length);
  return seen.map((el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      el,
      label: keys[index],
      top: Math.max(rect.top, 0),
      left: Math.max(rect.left, 0),
    };
  });
}

export function Jump({ onDone }: { onDone: () => void }) {
  const targets = useMemo(() => collect(), []);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Nothing else on the page acts while the letters are up, or a jump
      // would also trip whatever that key normally does.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return onDone();
      if (event.key === "Backspace") return setTyped((current) => current.slice(0, -1));
      if (event.key.length !== 1) return;

      const next = typed + event.key.toLowerCase();
      const hit = targets.find((target) => target.label === next);
      if (hit) {
        onDone();
        // Focusing a box you can type in is the jump; anything else is a
        // press.
        const box =
          hit.el instanceof HTMLInputElement ||
          hit.el instanceof HTMLTextAreaElement ||
          hit.el instanceof HTMLSelectElement;
        if (box) hit.el.focus();
        else hit.el.click();
        return;
      }
      if (targets.some((target) => target.label.startsWith(next))) setTyped(next);
      else onDone();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [targets, typed, onDone]);

  return (
    <div data-jump aria-hidden className="pointer-events-none fixed inset-0 z-50">
      {targets
        .filter((target) => target.label.startsWith(typed))
        .map((target) => (
          <span
            key={target.label}
            style={{ top: target.top, left: target.left }}
            className="tnum absolute flex h-[18px] min-w-[18px] items-center justify-center bg-ink px-1 text-[11px] font-semibold text-paper"
          >
            {target.label.slice(typed.length)}
          </span>
        ))}
    </div>
  );
}
