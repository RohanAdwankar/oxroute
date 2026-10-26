export type PaneLayout = string | { axis: "row" | "column"; ratio: number; first: PaneLayout; second: PaneLayout };
export type PaneEdge = "left" | "right" | "top" | "bottom";
export const paneIds = (tree: PaneLayout | null): string[] => tree === null ? [] : typeof tree === "string" ? [tree] : [...paneIds(tree.first), ...paneIds(tree.second)];

export function removePane(tree: PaneLayout | null, id: string): PaneLayout | null {
  if (tree === null || typeof tree === "string") return tree === id ? null : tree;
  const first = removePane(tree.first, id), second = removePane(tree.second, id);
  return first === null ? second : second === null ? first : { ...tree, first, second };
}

export function movePane(tree: PaneLayout, id: string, target: string, edge: PaneEdge): PaneLayout {
  return dockPanes(tree, id, target, edge);
}

export function dockPanes(tree: PaneLayout, incoming: PaneLayout, target: string, edge: PaneEdge): PaneLayout {
  if (!paneIds(tree).includes(target)) return tree;
  const group = removePane(incoming, target);
  if (group === null) return tree;
  for (const id of paneIds(group)) tree = removePane(tree, id)!;
  const insert = (node: PaneLayout): PaneLayout => {
    if (typeof node !== "string") return { ...node, first: insert(node.first), second: insert(node.second) };
    if (node !== target) return node;
    const before = edge === "left" || edge === "top";
    return { axis: edge === "left" || edge === "right" ? "row" : "column", ratio: 0.5, first: before ? group : node, second: before ? node : group };
  };
  return insert(tree);
}

export function syncPanes(tree: PaneLayout | null, ids: string[]): PaneLayout | null {
  for (const id of paneIds(tree)) if (!ids.includes(id)) tree = removePane(tree, id);
  for (const [index, id] of ids.entries()) if (!paneIds(tree).includes(id)) tree = tree === null ? id : movePane(tree, id, ids[index - 1] ?? paneIds(tree)[0], index ? "right" : "left");
  return tree;
}

export function readPanes(key: string): PaneLayout | null {
  const valid = (node: unknown, depth = 0): node is PaneLayout => {
    if (typeof node === "string") return node.length > 0;
    if (!node || typeof node !== "object" || depth > 16) return false;
    const value = node as Exclude<PaneLayout, string>;
    return ["row", "column"].includes(value.axis) && value.ratio > 0 && value.ratio < 1 && valid(value.first, depth + 1) && valid(value.second, depth + 1);
  };
  try {
    const name = `oxroute.panes.${key}`;
    // A window starts with the saved layout, then keeps its own working copy.
    if (sessionStorage.getItem(name) === null && localStorage.getItem(name) !== null) {
      sessionStorage.setItem(name, localStorage.getItem(name)!);
    }
    const tree: unknown = JSON.parse(sessionStorage.getItem(name) ?? "null");
    return valid(tree) && new Set(paneIds(tree)).size === paneIds(tree).length ? tree : null;
  } catch { return null; }
}

export function writePanes(key: string, tree: PaneLayout | null): void {
  const name = `oxroute.panes.${key}`;
  sessionStorage.setItem(name, JSON.stringify(tree));
  if (tree) localStorage.setItem(name, JSON.stringify(tree));
  else localStorage.removeItem(name);
}
