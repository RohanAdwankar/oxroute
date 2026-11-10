import { useMemo, useState, useSyncExternalStore } from "react";
import type { AgentView } from "./types";

type Views = Record<string, AgentView>;

function createViews() {
  let views: Views = {};
  const listeners = new Set<() => void>();
  return {
    read: () => views,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (change: (current: Views) => Views) => {
      views = change(views);
      for (const listener of listeners) listener();
    },
    select: (ids: string[]) => {
      let previous: (AgentView | undefined)[] = [];
      return () => {
        const next = ids.map(id => views[id]);
        if (next.length !== previous.length || next.some((view, index) => view !== previous[index])) previous = next;
        return previous;
      };
    },
  };
}

/** Keep preloaded histories without repainting conversations that are not open. */
export function useAgentViews(visible: string[]) {
  const [store] = useState(createViews);
  const selected = useMemo(() => store.select(visible), [store, visible]);
  useSyncExternalStore(store.subscribe, selected, selected);
  return [store.read(), store.update] as const;
}
