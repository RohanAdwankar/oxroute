/** Keep PR form text out of Safari web-app authentication URL heuristics. */
export function encodePrFormLink(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch { return href; }
  const path = url.pathname.split("/").slice(1);
  if (url.hostname !== "github.com" || !["https:", "http:"].includes(url.protocol) ||
      !(path[2] === "compare" || (path[2] === "pull" && path[3] === "new"))) return href;
  let changed = false;
  const query = url.search.slice(1).split("&").map(field => {
    for (const [key, value] of new URLSearchParams(field)) {
      if (key !== "title" && key !== "body") continue;
      changed = true;
      const encoded = Array.from(new TextEncoder().encode(value), byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
      return `${key}=${encoded}`;
    }
    return field;
  });
  if (!changed) return href;
  url.search = query.join("&");
  return url.href;
}
