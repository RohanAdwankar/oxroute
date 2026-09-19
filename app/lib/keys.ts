"use client";

/**
 * Keyboard hints for the fleet.
 *
 * The goal is one keystroke from "this arrived" to "that agent has it", so
 * every agent on screen carries a letter you can type. `hjkl` is reserved for
 * moving around, which is the whole reason vim users want the mode at all,
 * and the rest of the home row comes first because that is where your hands
 * already are.
 */
export const HINTS = [
  "a",
  "s",
  "d",
  "f",
  "g",
  "q",
  "w",
  "e",
  "r",
  "t",
  "z",
  "x",
  "c",
  "v",
  "b",
  "y",
  "u",
  "i",
  "o",
  "p",
] as const;

/** Keys that mean "move", and so can never be a hint. */
export const RESERVED = new Set(["h", "j", "k", "l", "n", "m"]);

export function hintFor(index: number): string | null {
  return HINTS[index] ?? null;
}

/**
 * True when the key should go to whatever the person is typing in rather
 * than to the shortcut handler.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}


/**
 * Whether the one-key hints are on, remembered per browser.
 *
 * This is an external store rather than component state because it is read
 * during the first render and lives in `localStorage`, which does not exist
 * on the server. `useSyncExternalStore` is built for exactly that: the
 * server gets a stable answer, the browser gets the real one, and neither
 * has to write state from inside an effect.
 */
const KEY = "oxroute.vim";
let cached: boolean | null = null;
const listeners = new Set<() => void>();

export function getVimMode(): boolean {
  if (cached === null) {
    try {
      // On by default; only an explicit "false" turns it off.
      cached = window.localStorage.getItem(KEY) !== "false";
    } catch {
      cached = true;
    }
  }
  return cached;
}

/** What the server renders, before any browser storage is readable. */
export function defaultVimMode(): boolean {
  return true;
}

export function setVimMode(next: boolean): void {
  cached = next;
  try {
    window.localStorage.setItem(KEY, String(next));
  } catch {
    /* a preference is a convenience, not state worth failing over */
  }
  for (const listener of listeners) listener();
}

export function subscribeVimMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
