import { create } from "zustand";
import type { DockviewApi } from "dockview-react";

export type RibbonTab =
  | "project"
  | "home"
  | "simulations"
  | "results"
  | "optimization"
  | "parameters";

// Canvas connection layers. Electrical/mechanical are real React Flow edges;
// "signal" toggles a dashed data-bus overlay (drawn from dataBusConnections).
export type EdgeKindFilter = "electrical" | "mechanical" | "signal";

export type Theme = "light" | "dark";

/** A request to show the app's styled confirm/prompt modal (replaces the
 *  native window.confirm/prompt). `resolve` settles the caller's promise. */
export interface DialogRequest {
  kind: "confirm" | "prompt";
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string; // prompt only
  placeholder?: string; // prompt only
  resolve: (value: boolean | string | null) => void;
}

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

  /** Live-value overlay chips on canvas nodes (fed from the live run stream). */
  showLiveValues: boolean;
  toggleLiveValues: () => void;

  /** Element whose parameters are open in the modal dialog (double-click). */
  paramDialogId: string | null;
  openParamDialog: (elementId: string) => void;
  closeParamDialog: () => void;

  /** Styled confirm/prompt modal (see dialog.ts helpers). */
  dialog: DialogRequest | null;
  openDialog: (req: DialogRequest) => void;
  closeDialog: () => void;

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

  visibleKinds: { electrical: true, mechanical: true, signal: false },
  toggleKind: (kind) =>
    set((s) => ({
      visibleKinds: { ...s.visibleKinds, [kind]: !s.visibleKinds[kind] },
    })),

  showLiveValues: true,
  toggleLiveValues: () => set((s) => ({ showLiveValues: !s.showLiveValues })),

  paramDialogId: null,
  openParamDialog: (elementId) => set({ paramDialogId: elementId }),
  closeParamDialog: () => set({ paramDialogId: null }),

  dialog: null,
  openDialog: (req) => set({ dialog: req }),
  closeDialog: () => set({ dialog: null }),

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
