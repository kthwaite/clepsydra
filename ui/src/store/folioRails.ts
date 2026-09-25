import { create } from "zustand";

/** Storage-key stems used by Folio's two sidebars (useCollapsibleRail
 *  appends `.collapsed` / `.w`). Kept identical to the pre-store keys so
 *  users keep their state. */
export const FOLIO_LEFT_RAIL = "clp.folio.l";
export const FOLIO_RIGHT_RAIL = "clp.folio.r";

const collapsedKey = (stem: string) => `${stem}.collapsed`;

function read(stem: string): boolean {
  try {
    return window.localStorage.getItem(collapsedKey(stem)) === "1";
  } catch {
    return false;
  }
}

function write(stem: string, v: boolean) {
  try {
    window.localStorage.setItem(collapsedKey(stem), v ? "1" : "0");
  } catch {
    // ignore
  }
}

interface FolioRailsState {
  collapsed: Record<string, boolean>;
  isCollapsed: (stem: string) => boolean;
  setCollapsed: (stem: string, v: boolean) => void;
  toggle: (stem: string) => void;
  toggleBoth: () => void;
}

/** Collapsed state for collapsible rails, shared so global shortcuts can
 *  drive Folio's sidebars. Width stays local to useCollapsibleRail. */
export const useFolioRails = create<FolioRailsState>((set, get) => ({
  collapsed: {},
  isCollapsed: (stem) => get().collapsed[stem] ?? read(stem),
  setCollapsed: (stem, v) => {
    write(stem, v);
    set((s) => ({ collapsed: { ...s.collapsed, [stem]: v } }));
  },
  toggle: (stem) => get().setCollapsed(stem, !get().isCollapsed(stem)),
  toggleBoth: () => {
    const { isCollapsed, setCollapsed } = get();
    const anyOpen =
      !isCollapsed(FOLIO_LEFT_RAIL) || !isCollapsed(FOLIO_RIGHT_RAIL);
    setCollapsed(FOLIO_LEFT_RAIL, anyOpen);
    setCollapsed(FOLIO_RIGHT_RAIL, anyOpen);
  },
}));
