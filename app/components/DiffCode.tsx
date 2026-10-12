import { common, createLowlight } from "lowlight";
import { diffWordsWithSpace } from "diff";
import { newMatcherFn } from "diff2html/lib/rematch";
import { distance } from "fastest-levenshtein";
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
  const spans: [number, number][][] = rows.map(row =>
    (row.old === null) !== (row.next === null) ? [[0, row.text.length - 1]] : []);
  const source = rows.map(row => row.text.slice(1).trim());
  const match = newMatcherFn((a: number, b: number) =>
    distance(source[a], source[b]) / Math.max(1, source[a].length + source[b].length));
  for (let start = 0; start < rows.length;) {
    if (rows[start].next !== null || rows[start].old === null) { start++; continue; }
    let end = start;
    while (end < rows.length && rows[end].old !== null && rows[end].next === null) end++;
    const addedStart = end;
    while (end < rows.length && rows[end].old === null && rows[end].next !== null) end++;
    const indices = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => from + at);
    for (const [before, after] of match(indices(start, addedStart), indices(addedStart, end))) {
      for (let at = 0; at < Math.min(before.length, after.length); at++) {
        const offsets = [0, 0], pair = [before[at], after[at]];
        for (const index of pair) spans[index] = [];
        for (const part of diffWordsWithSpace(rows[pair[0]].text.slice(1), rows[pair[1]].text.slice(1))) {
          for (const side of [0, 1]) {
            if ((side === 0 && part.added) || (side === 1 && part.removed)) continue;
            if (part.added || part.removed) spans[pair[side]].push([offsets[side], offsets[side] + part.value.length]);
            offsets[side] += part.value.length;
          }
        }
      }
    }
    start = end;
  }
  for (const [index, ranges] of spans.entries()) {
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && !rows[index].text.slice(1 + previous[1], 1 + range[0]).trim()) previous[1] = range[1];
      else merged.push(range);
    }
    spans[index] = merged;
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
