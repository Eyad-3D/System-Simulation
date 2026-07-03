import { create } from "zustand";
import type { DockviewApi } from "dockview-react";

export type RibbonTab =
  | "project"
  | "home"
  | "simulations"
  | "results"
  | "optimization"
  | "parameters";

export type EdgeKindFilter = "electrical" | "mechanical" | "signal";

interface UIState {
  ribbonTab: RibbonTab;
  setRibbonTab: (tab: RibbonTab) => void;

  dockApi: DockviewApi | null;
  setDockApi: (api: DockviewApi) => void;
  /** Bring a dockview panel to the front of its group. */
  focusPanel: (id: string) => void;

  /** Layer Configurations: per-kind edge visibility on the canvas. */
  visibleKinds: Record<EdgeKindFilter, boolean>;
  toggleKind: (kind: EdgeKindFilter) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  ribbonTab: "home",
  setRibbonTab: (tab) => set({ ribbonTab: tab }),

  dockApi: null,
  setDockApi: (api) => set({ dockApi: api }),
  focusPanel: (id) => {
    const panel = get().dockApi?.getPanel(id);
    panel?.api.setActive();
  },

  visibleKinds: { electrical: true, mechanical: true, signal: true },
  toggleKind: (kind) =>
    set((s) => ({
      visibleKinds: { ...s.visibleKinds, [kind]: !s.visibleKinds[kind] },
    })),
}));
