/** Wall-clock time of day, which is what a person compares against memory. */
// `toLocaleTimeString` builds a fresh Intl formatter on every call, which
// is most of the cost of drawing a long transcript: one per row, per
// render. Build it once, and remember what it said -- a timestamp never
// formats to anything different the second time.
const wall = new Intl.DateTimeFormat("en-GB", {
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const clocked = new Map<number, string>();

export function clock(at: number): string {
  const said = clocked.get(at);
  if (said !== undefined) return said;
  const text = wall.format(new Date(at * 1000));
  // A session is thousands of rows at the outside, and every one of them
  // is a timestamp somebody is looking at.
  if (clocked.size > 20000) clocked.clear();
  clocked.set(at, text);
  return text;
}

/** Coarser as it grows: nobody needs seconds on something two days old. */
export function since(at: number, now = Date.now() / 1000): string {
  const seconds = Math.max(0, Math.round(now - at));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Collapse whitespace, so a pasted shell transcript stays one line. */
export function flatten(text: string): string {
  return text.trim().split(/\s+/).join(" ");
}

export function clip(text: string, limit: number): string {
  const flat = flatten(text);
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
