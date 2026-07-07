import { create } from "zustand";
import type { DockviewApi } from "dockview-react";

export type RibbonTab =
  | "project"
  | "home"
  | "simulations"
  | "results"
  | "optimization"
  | "parameters";

// Signal/data-bus wiring is intentionally not drawn on the canvas — it lives
// in the Data Bus Connections panel.
export type EdgeKindFilter = "electrical" | "mechanical";

export type Theme = "light" | "dark";

const THEME_KEY = "simstudio-theme";

function loadTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* storage unavailable */
  }
  return "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

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

  /** Element whose parameters are open in the modal dialog (double-click). */
  paramDialogId: string | null;
  openParamDialog: (elementId: string) => void;
  closeParamDialog: () => void;

  theme: Theme;
  toggleTheme: () => void;
}

const initialTheme = loadTheme();
applyTheme(initialTheme);

export const useUIStore = create<UIState>((set, get) => ({
  ribbonTab: "home",
  setRibbonTab: (tab) => set({ ribbonTab: tab }),

  dockApi: null,
  setDockApi: (api) => set({ dockApi: api }),
  focusPanel: (id) => {
    const panel = get().dockApi?.getPanel(id);
    panel?.api.setActive();
  },

  visibleKinds: { electrical: true, mechanical: true },
  toggleKind: (kind) =>
    set((s) => ({
      visibleKinds: { ...s.visibleKinds, [kind]: !s.visibleKinds[kind] },
    })),

  paramDialogId: null,
  openParamDialog: (elementId) => set({ paramDialogId: elementId }),
  closeParamDialog: () => set({ paramDialogId: null }),

  theme: initialTheme,
  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable */
    }
    set({ theme: next });
  },
}));
