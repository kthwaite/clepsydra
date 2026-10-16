import { create } from "zustand";
import type { PreviewTarget } from "#/lib/previewTarget";
import { previewTargetKey } from "#/lib/previewTarget";

export interface PreviewWindow extends PreviewTarget {
  id: string;
  mode: "peek" | "reader";
  parentId?: string;
  opener?: HTMLElement;
  restricted?: boolean;
  focusRequest: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
  minimized: boolean;
  z: number;
}

export const PREVIEW_WIDTH = 340;
const PEEK_HEIGHT = 280;
const READER_WIDTH = 560;
const READER_HEIGHT = 560;
const PERSIST_KEY = "clp.preview.pinned";
const CLOSE_DELAY = 200;

type Geometry = Pick<PreviewWindow, "x" | "y" | "width" | "height">;
type Persisted = PreviewTarget & Geometry & { restricted?: boolean };
type OpenOptions = {
  mode?: "peek" | "reader";
  parentId?: string;
  opener?: HTMLElement;
  restricted?: boolean;
};

type PreviewState = {
  windows: PreviewWindow[];
  topZ: number;
  open: (target: PreviewTarget, rect: DOMRect, options?: OpenOptions) => string;
  expand: (id: string) => void;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  close: (id: string) => void;
  closePath: (path: string) => void;
  closePeeks: () => void;
  raise: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  commitMove: (id: string, x: number, y: number) => void;
  resize: (id: string, width: number, height: number) => void;
  clampAll: () => void;
  enter: (id: string) => void;
  leave: (id: string) => void;
  focusWithin: (id: string, inside: boolean) => void;
};

function clampGeometry(geometry: Geometry): Geometry {
  const viewportWidth =
    typeof window === "undefined" ? 1200 : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? 900 : window.innerHeight;
  const marginX = Math.min(8, Math.max(0, (viewportWidth - 1) / 2));
  const marginY = Math.min(8, Math.max(0, (viewportHeight - 1) / 2));
  const maxWidth = Math.max(1, viewportWidth - marginX * 2);
  const maxHeight = Math.max(1, viewportHeight - marginY * 2);
  const width = Math.min(
    maxWidth,
    Math.max(
      240,
      Number.isFinite(geometry.width) ? geometry.width : PREVIEW_WIDTH,
    ),
  );
  const height = Math.min(
    maxHeight,
    Math.max(
      160,
      Number.isFinite(geometry.height) ? geometry.height : PEEK_HEIGHT,
    ),
  );
  return {
    width,
    height,
    x: Math.min(
      viewportWidth - width - marginX,
      Math.max(marginX, Number.isFinite(geometry.x) ? geometry.x : marginX),
    ),
    y: Math.min(
      viewportHeight - height - marginY,
      Math.max(marginY, Number.isFinite(geometry.y) ? geometry.y : marginY),
    ),
  };
}

function savePinned(windows: PreviewWindow[]) {
  try {
    const pins: Persisted[] = windows
      .filter((win) => win.pinned)
      .map((win) => ({
        path: win.path,
        ...(win.heading !== undefined ? { heading: win.heading } : {}),
        ...(win.blockId !== undefined ? { blockId: win.blockId } : {}),
        ...(win.restricted ? { restricted: true } : {}),
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
      }));
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ version: 1, windows: pins }),
    );
  } catch {
    // Storage may be unavailable or full; session readers remain usable.
  }
}

function loadPinned(): PreviewWindow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    const legacy = Array.isArray(data);
    const entries: unknown = legacy
      ? data
      : data &&
          typeof data === "object" &&
          "version" in data &&
          data.version === 1 &&
          "windows" in data
        ? data.windows
        : [];
    if (!Array.isArray(entries)) return [];
    const windows: PreviewWindow[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      if (
        typeof value.path !== "string" ||
        !value.path.trim() ||
        typeof value.x !== "number" ||
        !Number.isFinite(value.x) ||
        typeof value.y !== "number" ||
        !Number.isFinite(value.y)
      )
        continue;
      if (value.heading !== undefined && typeof value.heading !== "string")
        continue;
      if (value.blockId !== undefined && typeof value.blockId !== "string")
        continue;
      if (
        !legacy &&
        (typeof value.width !== "number" ||
          !Number.isFinite(value.width) ||
          value.width <= 0 ||
          typeof value.height !== "number" ||
          !Number.isFinite(value.height) ||
          value.height <= 0)
      )
        continue;
      const target: PreviewTarget = {
        path: value.path,
        ...(typeof value.heading === "string"
          ? { heading: value.heading }
          : {}),
        ...(typeof value.blockId === "string"
          ? { blockId: value.blockId }
          : {}),
      };
      const key = previewTargetKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      const width =
        typeof value.width === "number" ? value.width : READER_WIDTH;
      const height =
        typeof value.height === "number" ? value.height : READER_HEIGHT;
      windows.push({
        ...target,
        ...clampGeometry({
          x: value.x,
          y: legacy && value.above === true ? value.y - height : value.y,
          width,
          height,
        }),
        id: `pin-${windows.length}`,
        mode: "reader",
        ...(value.restricted === true ? { restricted: true } : {}),
        focusRequest: 0,
        pinned: true,
        minimized: false,
        z: 100 + windows.length,
      });
    }
    savePinned(windows);
    return windows;
  } catch {
    return [];
  }
}

let nextId = 1;

export const usePreviewStore = create<PreviewState>((set, get) => {
  // Ownership is ephemeral and separate: a pointer exit cannot revoke keyboard focus.
  const pointer = new Set<string>();
  const focus = new Set<string>();
  const timers = new Map<string, number>();

  function ancestors(id: string, windows = get().windows): Set<string> {
    const chain = new Set<string>();
    let next: string | undefined = id;
    while (next && !chain.has(next)) {
      const win = windows.find((candidate) => candidate.id === next);
      if (!win) break;
      chain.add(next);
      next = win.parentId;
    }
    return chain;
  }

  function owned(id: string, focusOnly = false): boolean {
    for (const win of get().windows) {
      if (
        (focus.has(win.id) || (!focusOnly && pointer.has(win.id))) &&
        ancestors(win.id).has(id)
      )
        return true;
    }
    return false;
  }

  function cancel(id: string) {
    window.clearTimeout(timers.get(id));
    timers.delete(id);
  }

  function cancelBranch(id: string) {
    for (const ancestor of ancestors(id)) cancel(ancestor);
  }

  function remove(ids: Set<string>) {
    const original = get().windows;
    // Readers survive independently; all transient descendants belong to the
    // dismissed branch, including peeks opened from those surviving readers.
    for (const win of original) {
      if (win.mode !== "peek") continue;
      for (const ancestor of ancestors(win.id, original)) {
        if (ids.has(ancestor)) {
          ids.add(win.id);
          break;
        }
      }
    }
    if (!original.some((win) => ids.has(win.id))) return;
    for (const id of ids) {
      cancel(id);
      pointer.delete(id);
      focus.delete(id);
    }
    const windows = original
      .filter((win) => !ids.has(win.id))
      .map((win) =>
        win.parentId && ids.has(win.parentId)
          ? { ...win, parentId: undefined }
          : win,
      );
    set({ windows });
    savePinned(windows);
    for (const win of original) {
      if (ids.has(win.id) && win.parentId && !ids.has(win.parentId)) {
        scheduleBranch(win.parentId);
      }
    }
  }

  function scheduleBranch(id: string) {
    for (const ancestor of ancestors(id)) {
      const win = get().windows.find((candidate) => candidate.id === ancestor);
      if (win?.mode !== "peek" || owned(ancestor) || timers.has(ancestor))
        continue;
      const timer = window.setTimeout(() => {
        // Identity check also protects against an already-queued cancelled callback.
        if (timers.get(ancestor) !== timer) return;
        timers.delete(ancestor);
        if (
          get().windows.some(
            (candidate) =>
              candidate.id === ancestor && candidate.mode === "peek",
          ) &&
          !owned(ancestor)
        )
          remove(new Set([ancestor]));
      }, CLOSE_DELAY);
      timers.set(ancestor, timer);
    }
  }

  function update(
    id: string,
    change: (win: PreviewWindow) => PreviewWindow,
    persist = false,
  ) {
    const windows = get().windows.map((win) =>
      win.id === id ? change(win) : win,
    );
    set({ windows });
    if (persist) savePinned(windows);
  }

  function reader(win: PreviewWindow): PreviewWindow {
    if (win.mode === "reader") return win;
    return {
      ...win,
      mode: "reader",
      ...clampGeometry({
        ...win,
        width: Math.max(win.width, READER_WIDTH),
        height: Math.max(win.height, READER_HEIGHT),
      }),
    };
  }

  const initialWindows = loadPinned();

  return {
    windows: initialWindows,
    topZ: initialWindows.reduce((top, win) => Math.max(top, win.z), 200),
    open(target, rect, options = {}) {
      const state = get();
      const key = previewTargetKey(target);
      const existing = state.windows.find(
        (win) => previewTargetKey(win) === key,
      );
      const parentId = state.windows.some((win) => win.id === options.parentId)
        ? options.parentId
        : undefined;
      const keep = parentId ? ancestors(parentId) : new Set<string>();
      if (existing) for (const id of ancestors(existing.id)) keep.add(id);
      // A different root/sibling replaces peeks, never session readers or focused branches.
      remove(
        new Set(
          state.windows
            .filter(
              (win) =>
                win.mode === "peek" &&
                !keep.has(win.id) &&
                !owned(win.id, true),
            )
            .map((win) => win.id),
        ),
      );
      const mode = options.mode ?? "peek";
      const z = get().topZ + 1;
      if (existing) {
        cancelBranch(existing.id);
        update(
          existing.id,
          (win) => ({
            ...(mode === "reader" ? reader(win) : win),
            minimized: false,
            z,
            restricted: win.restricted || options.restricted,
            opener:
              mode === "reader" && options.opener ? options.opener : win.opener,
            focusRequest: win.focusRequest + (mode === "reader" ? 1 : 0),
          }),
          existing.pinned,
        );
        set({ topZ: z });
        return existing.id;
      }
      const id = `pv-${nextId++}`;
      const width = mode === "reader" ? READER_WIDTH : PREVIEW_WIDTH;
      const height = mode === "reader" ? READER_HEIGHT : PEEK_HEIGHT;
      const geometry = clampGeometry({
        x: rect.left,
        y:
          (rect.top + rect.bottom) / 2 > window.innerHeight / 2
            ? rect.top - height - 6
            : rect.bottom + 6,
        width,
        height,
      });
      const win: PreviewWindow = {
        ...target,
        ...geometry,
        id,
        mode,
        parentId,
        opener: options.opener,
        restricted: options.restricted,
        focusRequest: mode === "reader" ? 1 : 0,
        pinned: false,
        minimized: false,
        z,
      };
      set({ windows: [...get().windows, win], topZ: z });
      cancelBranch(id);
      return id;
    },
    expand(id) {
      cancelBranch(id);
      update(
        id,
        (win) => ({
          ...reader(win),
          minimized: false,
          focusRequest: win.focusRequest + 1,
        }),
        true,
      );
      get().raise(id);
    },
    pin(id) {
      cancelBranch(id);
      update(id, (win) => ({ ...reader(win), pinned: true }), true);
    },
    unpin(id) {
      update(id, (win) => ({ ...win, pinned: false }), true);
    },
    minimize(id) {
      cancelBranch(id);
      pointer.delete(id);
      focus.delete(id);
      update(id, (win) => ({ ...reader(win), minimized: true }), true);
      scheduleBranch(id);
    },
    restore(id) {
      update(id, (win) => ({
        ...win,
        minimized: false,
        focusRequest: win.focusRequest + (win.mode === "reader" ? 1 : 0),
      }));
      get().raise(id);
    },
    close(id) {
      remove(new Set([id]));
    },
    closePath(path) {
      remove(
        new Set(
          get()
            .windows.filter((win) => win.path === path)
            .map((win) => win.id),
        ),
      );
    },
    closePeeks() {
      remove(
        new Set(
          get()
            .windows.filter((win) => win.mode === "peek")
            .map((win) => win.id),
        ),
      );
    },
    raise(id) {
      if (!get().windows.some((win) => win.id === id)) return;
      const z = get().topZ + 1;
      update(id, (win) => ({ ...win, z }));
      set({ topZ: z });
    },
    move(id, x, y) {
      update(id, (win) => ({ ...win, ...clampGeometry({ ...win, x, y }) }));
    },
    commitMove(id, x, y) {
      update(
        id,
        (win) => ({ ...win, ...clampGeometry({ ...win, x, y }) }),
        true,
      );
    },
    resize(id, width, height) {
      update(
        id,
        (win) => ({ ...win, ...clampGeometry({ ...win, width, height }) }),
        true,
      );
    },
    clampAll() {
      const windows = get().windows.map((win) => ({
        ...win,
        ...clampGeometry(win),
      }));
      set({ windows });
      savePinned(windows);
    },
    enter(id) {
      if (!get().windows.some((win) => win.id === id)) return;
      pointer.add(id);
      cancelBranch(id);
    },
    leave(id) {
      pointer.delete(id);
      scheduleBranch(id);
    },
    focusWithin(id, inside) {
      if (inside) {
        if (!get().windows.some((win) => win.id === id)) return;
        focus.add(id);
        cancelBranch(id);
      } else {
        focus.delete(id);
        scheduleBranch(id);
      }
    },
  };
});
