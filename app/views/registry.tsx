"use client";

import type { ComponentType } from "react";

import type { IconName } from "../components/Icon";
import type { Snapshot, ViewInfo } from "../lib/types";
import { BoardView } from "./BoardView";

/**
 * What every view is handed. The same things the fleet gets, and nothing a
 * view could use to grow behaviour of its own: mutations go through `run`,
 * which goes through the daemon, which is where a view's logic lives.
 */
export interface ViewProps {
  view: ViewInfo;
  snapshot: Snapshot;
  /** Bumped on every daemon event, so a view refetches when anything changes. */
  revision: number;
  busy: boolean;
  run: (work: () => Promise<unknown>, after?: () => void) => Promise<void>;
  onOpenAgent: (id: string) => void;
  say: (text: string) => void;
}

export interface ViewModule {
  component: ComponentType<ViewProps>;
  icon: IconName;
}

/**
 * The views the main column can show besides the fleet, by `kind`.
 *
 * The daemon decides which views exist — `[[views]]` in the config file —
 * and this decides how each kind is drawn. Adding a kind is a variant in
 * `crates/oxroute-core/src/config.rs`, the endpoints it needs, a component
 * in this directory, and one line here.
 */
export const VIEWS: Record<string, ViewModule> = {
  board: { component: BoardView, icon: "board" },
};
