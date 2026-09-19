/** Wall-clock time of day, which is what a person compares against memory. */
export function clock(at: number): string {
  return new Date(at * 1000).toLocaleTimeString("en-GB", { hour12: false });
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
