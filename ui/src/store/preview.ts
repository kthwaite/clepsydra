import { create } from "zustand";

// Link-preview window manager. Hovering a wikilink spawns a transient preview;
// pinning makes it a persistent, draggable window; minimizing parks it in a
// bottom-left tray. Pinned windows + positions persist across reloads.

export type PreviewWindow = {
  id: string;
  path: string;
  x: number;
  y: number;
  pinned: boolean;
  minimized: boolean;
  z: number;
};

const W = 340;
const PERSIST_KEY = "clp.preview.pinned";

type Persisted = { path: string; x: number; y: number };

function loadPinned(): PreviewWindow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Persisted[];
    return arr.map((p, i) => ({
      id: `pin-${i}-${p.path}`,
      path: p.path,
      x: p.x,
      y: p.y,
      pinned: true,
      minimized: false,
      z: 100 + i,
    }));
  } catch {
    return [];
  }
}

function savePinned(windows: PreviewWindow[]) {
  try {
    const pinned: Persisted[] = windows
      .filter((w) => w.pinned)
      .map((w) => ({ path: w.path, x: w.x, y: w.y }));
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify(pinned));
  } catch {
    // ignore
  }
}

type PreviewState = {
  windows: PreviewWindow[];
  topZ: number;
  hoverId: string | null;
  openHover: (path: string, rect: DOMRect) => void;
  pin: (id: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  close: (id: string) => void;
  closePath: (path: string) => void;
  raise: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
};

let nextId = 1;
let closeTimer: number | null = null;

export const usePreviewStore = create<PreviewState>((set, get) => ({
  windows: loadPinned(),
  topZ: 200,
  hoverId: null,

  openHover(path, rect) {
    const state = get();
    // If a window for this path already exists, surface it instead of stacking.
    const existing = state.windows.find((w) => w.path === path);
    if (existing) {
      get().restore(existing.id);
      return;
    }
    const vw = window.innerWidth;
    const x = Math.min(Math.max(8, rect.left), vw - W - 8);
    const y = rect.bottom + 6;
    const z = state.topZ + 1;
    const id = `pv-${nextId++}`;
    // Replace any prior transient hover window.
    const kept = state.windows.filter(
      (w) => w.pinned || w.id !== state.hoverId,
    );
    set({
      windows: [
        ...kept,
        { id, path, x, y, pinned: false, minimized: false, z },
      ],
      topZ: z,
      hoverId: id,
    });
  },

  pin(id) {
    set((s) => {
      const windows = s.windows.map((w) =>
        w.id === id ? { ...w, pinned: true } : w,
      );
      savePinned(windows);
      return { windows, hoverId: s.hoverId === id ? null : s.hoverId };
    });
  },

  minimize(id) {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id ? { ...w, minimized: true } : w,
      ),
    }));
  },

  restore(id) {
    set((s) => {
      const z = s.topZ + 1;
      return {
        windows: s.windows.map((w) =>
          w.id === id ? { ...w, minimized: false, z } : w,
        ),
        topZ: z,
      };
    });
  },

  close(id) {
    set((s) => {
      const windows = s.windows.filter((w) => w.id !== id);
      savePinned(windows);
      return { windows, hoverId: s.hoverId === id ? null : s.hoverId };
    });
  },

  closePath(path) {
    set((s) => {
      const windows = s.windows.filter((w) => w.path !== path);
      savePinned(windows);
      return {
        windows,
        hoverId:
          s.hoverId && s.windows.some((w) => w.id === s.hoverId && w.path === path)
            ? null
            : s.hoverId,
      };
    });
  },

  raise(id) {
    set((s) => {
      const z = s.topZ + 1;
      return {
        windows: s.windows.map((w) => (w.id === id ? { ...w, z } : w)),
        topZ: z,
      };
    });
  },

  move(id, x, y) {
    set((s) => {
      const windows = s.windows.map((w) => (w.id === id ? { ...w, x, y } : w));
      savePinned(windows);
      return { windows };
    });
  },
}));

export const PREVIEW_WIDTH = W;

// Hover close is debounced so the pointer can travel from link into the window.
export function scheduleHoverClose() {
  cancelHoverClose();
  closeTimer = window.setTimeout(() => {
    const { hoverId, close } = usePreviewStore.getState();
    if (hoverId) close(hoverId);
  }, 200);
}

export function cancelHoverClose() {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
}
