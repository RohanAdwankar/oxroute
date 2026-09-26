"use client";

/**
 * Keys the interface itself owns: moving around, and the actions that apply
 * to the whole routing question rather than to one agent. A letter here can
 * never be a hint, or the badge on a card would do something else.
 */
export const RESERVED = new Set(["h", "j", "k", "l", "g", "m", "v", "i", "n", "d", "f"]);

/**
 * Keyboard hints for the fleet.
 *
 * The goal is one keystroke from "this arrived" to "that agent has it", so
 * every agent on screen carries a letter you can type. The home row comes
 * first because that is where your hands already are, and anything the
 * interface has claimed drops out.
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
].filter((key) => !RESERVED.has(key));

/**
 * The keys that only mean something with the hints on: someone with the
 * hints off is likelier to be about to type them than to have pressed them
 * on purpose. v and ? are not here on purpose -- one turns the hints back
 * on and the other says how, so they answer whatever state you are in.
 */
export const LETTERS = new Set([
  "h",
  "j",
  "k",
  "l",
  "g",
  "G",
  "m",
  "i",
  "/",
  "n",
  "d",
  "f",
]);

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


/**
 * How much room the interface takes: "wide" as it was, "compact" with the
 * air taken out.
 *
 * It is an attribute on the document rather than a prop threaded through
 * every component, because every component that has a size wants it and
 * none of them want to think about it.
 */
export type Density = "wide" | "compact";

const DENSITY = "oxroute.density";
let density: Density | null = null;
const watchers = new Set<() => void>();

export function getDensity(): Density {
  if (density === null) {
    try {
      density = window.localStorage.getItem(DENSITY) === "wide" ? "wide" : "compact";
    } catch {
      density = "compact";
    }
    document.documentElement.dataset.density = density;
  }
  return density;
}

/** What the server renders, before any browser storage is readable. */
export function defaultDensity(): Density {
  return "compact";
}

export function setDensity(next: Density): void {
  density = next;
  document.documentElement.dataset.density = next;
  try {
    window.localStorage.setItem(DENSITY, next);
  } catch {
    /* a preference is a convenience, not state worth failing over */
  }
  for (const watcher of watchers) watcher();
}

export function subscribeDensity(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}
