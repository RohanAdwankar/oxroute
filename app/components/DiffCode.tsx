import { common, createLowlight } from "lowlight";
import { diffWordsWithSpace } from "diff";
import type { RootContent } from "hast";

type Line = { text: string; old: number | null; next: number | null };
type Token = { text: string; className: string };
const syntax = createLowlight(common);

function tokens(source: string, path: string): Token[][] {
  const language = path.split(".").at(-1)!.toLowerCase();
  const tree = syntax.registered(language) ? syntax.highlight(language, source) : syntax.highlightAuto(source);
  const rows: Token[][] = [[]];
  const walk = (nodes: RootContent[], className = "") => {
    for (const node of nodes) {
      if (node.type === "element") {
        walk(node.children, [className, ...(node.properties.className as string[] ?? [])].join(" "));
      } else if (node.type === "text") {
        node.value.split("\n").forEach((text, index) => {
          if (index) rows.push([]);
          if (text) rows.at(-1)!.push({ text, className });
        });
      }
    }
  };
  walk(tree.children);
  return rows;
}

export function diffCode(rows: Line[], path: string) {
  const spans = rows.map(() => [] as [number, number][]);
  // Compare complete replacement blocks so inserted lines do not shift pairing.
  for (let start = 0; start < rows.length;) {
    if (rows[start].next !== null || rows[start].old === null) { start++; continue; }
    let end = start;
    while (end < rows.length && rows[end].old !== null && rows[end].next === null) end++;
    const addedStart = end;
    while (end < rows.length && rows[end].old === null && rows[end].next !== null) end++;
    if (addedStart === end) { start = end; continue; }
    const old = rows.slice(start, addedStart).map(row => row.text.slice(1)).join("\n");
    const next = rows.slice(addedStart, end).map(row => row.text.slice(1)).join("\n");
    const offsets = [0, 0];
    const ranges: [number, number][][] = [[], []];
    for (const part of diffWordsWithSpace(old, next)) {
      for (const side of [0, 1]) {
        if ((side === 0 && part.added) || (side === 1 && part.removed)) continue;
        if (part.added || part.removed) ranges[side].push([offsets[side], offsets[side] + part.value.length]);
        offsets[side] += part.value.length;
      }
    }
    for (const [side, from, to] of [[0, start, addedStart], [1, addedStart, end]]) {
      let offset = 0;
      for (let index = from; index < to; index++) {
        const length = rows[index].text.length - 1;
        spans[index] = ranges[side].flatMap(([a, b]) => b > offset && a < offset + length
          ? [[Math.max(0, a - offset), Math.min(length, b - offset)]] : []);
        offset += length + 1;
      }
    }
    start = end;
  }
  const oldTokens = tokens(rows.filter(row => row.old !== null).map(row => row.text.slice(1)).join("\n"), path);
  const nextTokens = tokens(rows.filter(row => row.next !== null).map(row => row.text.slice(1)).join("\n"), path);
  let before = 0, after = 0;
  return rows.map((row, index) => {
    const old = row.old !== null ? oldTokens[before++] : undefined;
    const next = row.next !== null ? nextTokens[after++] : undefined;
    if (!old && !next) return row.text;
    let offset = 0;
    const content = (next ?? old ?? []).flatMap((token, tokenIndex) => {
      const start = offset;
      offset += token.text.length;
      const cuts = [start, offset, ...spans[index].flat().filter(at => at > start && at < offset)].sort((a, b) => a - b);
      return cuts.slice(1).map((end, at) => {
        const begin = cuts[at], changed = spans[index].some(([a, b]) => begin >= a && end <= b);
        return <span key={`${tokenIndex}-${at}`} className={token.className} data-diff-change={changed || undefined}
          style={changed ? { backgroundColor: row.next === null ? "color-mix(in srgb, var(--color-remove) 24%, transparent)" : "color-mix(in srgb, var(--color-ok) 24%, transparent)" } : undefined}>{token.text.slice(begin - start, end - start)}</span>;
      });
    });
    return <>{row.text[0]}{content}</>;
  });
}
