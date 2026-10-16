import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewStore } from "#/store/preview";

let store = usePreviewStore;
const rect = () => new DOMRect(100, 100, 80, 20);
const current = (id: string) =>
  store.getState().windows.find((win) => win.id === id);

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.innerWidth = 1200;
  window.innerHeight = 900;
  store.setState({ windows: [], topZ: 200 });
});

afterEach(() => {
  for (const win of store.getState().windows) store.getState().close(win.id);
  vi.useRealTimers();
});

describe("reader lifecycle", () => {
  it("promotes a peek without losing its passage, and unpin leaves a session reader", () => {
    const actions = store.getState();
    const id = actions.open(
      { path: "notes/a.md", heading: "Introduction" },
      rect(),
    );
    expect(current(id)).toMatchObject({ mode: "peek", focusRequest: 0 });

    actions.expand(id);
    expect(current(id)).toMatchObject({
      mode: "reader",
      heading: "Introduction",
      pinned: false,
      focusRequest: 1,
    });
    actions.pin(id);
    expect(current(id)?.pinned).toBe(true);
    actions.unpin(id);
    expect(current(id)).toMatchObject({ mode: "reader", pinned: false });
    actions.close(id);
    expect(current(id)).toBeUndefined();
  });
});

describe("branch ownership", () => {
  it("allows link → child → parent travel without a stale ancestor close", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect());
    actions.enter(a);
    actions.leave(a);
    vi.advanceTimersByTime(150);
    const b = actions.open({ path: "b.md" }, rect(), { parentId: a });
    actions.enter(b);
    vi.advanceTimersByTime(300);
    expect(current(a)).toBeDefined();
    expect(current(b)).toBeDefined();
    actions.leave(b);
    vi.advanceTimersByTime(150);
    actions.enter(a);
    vi.advanceTimersByTime(100);
    expect(current(a)).toBeDefined();
    expect(current(b)).toBeUndefined();
    actions.leave(a);
    vi.advanceTimersByTime(200);
    expect(store.getState().windows).toHaveLength(0);
  });

  it("keeps keyboard-owned branches alive after pointer exit, then dismisses on blur", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect());
    const b = actions.open({ path: "b.md" }, rect(), { parentId: a });
    actions.enter(b);
    actions.focusWithin(b, true);
    actions.leave(b);
    vi.advanceTimersByTime(1000);
    expect(store.getState().windows.map((win) => win.id)).toEqual([a, b]);
    actions.focusWithin(b, false);
    vi.advanceTimersByTime(200);
    expect(store.getState().windows).toHaveLength(0);
  });

  it("does not transfer an old root's timeout to a later root", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect());
    actions.leave(a);
    vi.advanceTimersByTime(100);
    const b = actions.open({ path: "b.md" }, rect());
    vi.advanceTimersByTime(150);
    expect(current(a)).toBeUndefined();
    expect(current(b)).toBeDefined();
    actions.leave(b);
    vi.advanceTimersByTime(199);
    expect(current(b)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(current(b)).toBeUndefined();
  });

  it("replaces a transient root branch without closing independent readers", () => {
    const actions = store.getState();
    const reader = actions.open({ path: "reference.md" }, rect(), {
      mode: "reader",
    });
    const pinned = actions.open({ path: "pinned.md" }, rect());
    actions.pin(pinned);
    const a = actions.open({ path: "a.md" }, rect());
    const b = actions.open({ path: "b.md" }, rect(), { parentId: a });
    const c = actions.open({ path: "c.md" }, rect());
    expect(current(a)).toBeUndefined();
    expect(current(b)).toBeUndefined();
    expect(store.getState().windows.map((win) => win.id)).toEqual([
      reader,
      pinned,
      c,
    ]);
  });

  it("never dismisses a reader or minimized peek on an old hover timeout", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect());
    actions.leave(a);
    actions.expand(a);
    const b = actions.open({ path: "b.md" }, rect());
    actions.leave(b);
    actions.minimize(b);
    vi.advanceTimersByTime(1000);
    expect(current(a)?.mode).toBe("reader");
    expect(current(b)).toMatchObject({ mode: "reader", minimized: true });
    actions.restore(b);
    expect(current(b)?.minimized).toBe(false);
    actions.leave(a);
    actions.leave(b);
    vi.advanceTimersByTime(1000);
    expect(store.getState().windows).toHaveLength(2);
  });

  it("closes transient descendants but detaches explicit child readers", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect(), { mode: "reader" });
    const b = actions.open({ path: "b.md" }, rect(), { parentId: a });
    const c = actions.open({ path: "c.md" }, rect(), {
      mode: "reader",
      parentId: b,
    });
    actions.close(a);
    expect(current(a)).toBeUndefined();
    expect(current(b)).toBeUndefined();
    expect(current(c)).toMatchObject({ mode: "reader", parentId: undefined });
    actions.leave(c);
    vi.advanceTimersByTime(1000);
    expect(current(c)).toBeDefined();
  });

  it("closing a child leaves its parent's geometry and identity intact", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect(), { mode: "reader" });
    actions.move(a, 180, 200);
    const parent = current(a);
    const b = actions.open({ path: "b.md" }, rect(), {
      mode: "reader",
      parentId: a,
    });
    actions.close(b);
    expect(current(a)).toEqual(parent);
  });

  it("reuses ancestors without cycles and only explicit activation requests focus", () => {
    const actions = store.getState();
    const opener = document.createElement("button");
    const a = actions.open({ path: "a.md" }, rect(), {
      mode: "reader",
      opener,
    });
    const b = actions.open({ path: "b.md" }, rect(), {
      mode: "reader",
      parentId: a,
    });
    const reused = actions.open({ path: "a.md" }, rect(), { parentId: b });
    expect(reused).toBe(a);
    expect(current(a)).toMatchObject({
      mode: "reader",
      focusRequest: 1,
      parentId: undefined,
      opener,
    });
    expect(current(b)?.parentId).toBe(a);
    expect(current(a)?.z).toBeGreaterThan(current(b)?.z ?? 0);
    actions.open({ path: "a.md" }, rect(), { mode: "reader", parentId: b });
    expect(current(a)?.focusRequest).toBe(2);
    expect(store.getState().windows).toHaveLength(2);
  });

  it("distinguishes passages and closes all addresses of a removed page", () => {
    const actions = store.getState();
    const first = actions.open({ path: "a.md", heading: "One" }, rect(), {
      mode: "reader",
    });
    const second = actions.open({ path: "a.md", heading: "Two" }, rect(), {
      mode: "reader",
    });
    const block = actions.open({ path: "a.md", blockId: "block-1" }, rect(), {
      mode: "reader",
    });
    const other = actions.open({ path: "other.md" }, rect(), {
      mode: "reader",
    });
    expect(new Set([first, second, block]).size).toBe(3);
    actions.closePath("a.md");
    expect(store.getState().windows.map((win) => win.id)).toEqual([other]);
    actions.closePath("missing.md");
    expect(current(other)).toBeDefined();
  });

  it("closes peeks without dismissing their independently opened child reader", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect());
    const b = actions.open({ path: "b.md" }, rect(), {
      parentId: a,
      mode: "reader",
    });
    actions.closePeeks();
    expect(current(a)).toBeUndefined();
    expect(current(b)).toMatchObject({ mode: "reader", parentId: undefined });
  });

  it("preserves focus-owned branches when a pointer opens another root", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect());
    actions.focusWithin(a, true);
    const b = actions.open({ path: "b.md" }, rect());
    expect(current(a)).toBeDefined();
    expect(current(b)).toBeDefined();
    actions.focusWithin(a, false);
    vi.advanceTimersByTime(200);
    expect(current(a)).toBeUndefined();
    expect(current(b)).toBeDefined();
  });

  it("releases an unfocused ancestor after its focus-owning child closes", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect());
    const b = actions.open({ path: "b.md" }, rect(), {
      parentId: a,
      mode: "reader",
    });
    actions.focusWithin(b, true);
    actions.leave(a);
    vi.advanceTimersByTime(300);
    expect(current(a)).toBeDefined();
    actions.close(b);
    vi.advanceTimersByTime(200);
    expect(current(a)).toBeUndefined();
  });

  it("closes every transient descendant while keeping explicitly opened readers", () => {
    const actions = store.getState();
    const a = actions.open({ path: "a.md" }, rect(), { mode: "reader" });
    const b = actions.open({ path: "b.md" }, rect(), {
      parentId: a,
      mode: "reader",
    });
    const c = actions.open({ path: "c.md" }, rect(), { parentId: b });
    actions.close(a);
    expect(current(c)).toBeUndefined();
    expect(current(b)).toMatchObject({ mode: "reader", parentId: undefined });
  });

  it("explicit activation promotes the existing peek and cancels its pending close", () => {
    const actions = store.getState();
    const id = actions.open({ path: "a.md", blockId: "paragraph" }, rect());
    actions.leave(id);
    vi.advanceTimersByTime(150);
    const opener = document.createElement("button");
    expect(
      actions.open({ path: "a.md", blockId: "paragraph" }, rect(), {
        mode: "reader",
        opener,
      }),
    ).toBe(id);
    vi.advanceTimersByTime(100);
    expect(current(id)).toMatchObject({
      mode: "reader",
      pinned: false,
      focusRequest: 1,
      opener,
      blockId: "paragraph",
    });
    expect(store.getState().windows).toHaveLength(1);
  });

  it("pinning cancels pending dismissal without forcing a focus request", () => {
    const actions = store.getState();
    const id = actions.open({ path: "a.md" }, rect());
    actions.leave(id);
    actions.pin(id);
    vi.advanceTimersByTime(500);
    expect(current(id)).toMatchObject({
      mode: "reader",
      pinned: true,
      focusRequest: 0,
    });
  });

  it("a closed target's timer cannot dismiss its newly reopened window", () => {
    const actions = store.getState();
    const old = actions.open({ path: "a.md" }, rect());
    actions.leave(old);
    vi.advanceTimersByTime(100);
    actions.close(old);
    const reopened = actions.open({ path: "a.md" }, rect());
    actions.enter(reopened);
    vi.advanceTimersByTime(1000);
    expect(current(reopened)).toBeDefined();
    actions.leave(reopened);
    vi.advanceTimersByTime(200);
    expect(current(reopened)).toBeUndefined();
  });
});

describe("viewport geometry", () => {
  it("places peeks below upper links and above lower links using top-left coordinates", () => {
    const actions = store.getState();
    const upper = actions.open(
      { path: "upper.md" },
      new DOMRect(100, 100, 50, 20),
    );
    expect(current(upper)?.y).toBe(126);
    actions.close(upper);
    const lower = actions.open(
      { path: "lower.md" },
      new DOMRect(100, 700, 50, 20),
    );
    const win = current(lower);
    expect(win).toBeDefined();
    expect((win?.y ?? 0) + (win?.height ?? 0)).toBe(694);
  });

  it("keeps dragging, resizing and orientation changes within the viewport", () => {
    const actions = store.getState();
    const id = actions.open(
      { path: "edge.md" },
      new DOMRect(1190, 880, 10, 20),
      { mode: "reader" },
    );
    actions.move(id, -100, -100);
    expect(current(id)).toMatchObject({ x: 8, y: 8 });
    actions.commitMove(id, 5000, 5000);
    let win = current(id);
    expect((win?.x ?? 0) + (win?.width ?? 0)).toBe(1192);
    expect((win?.y ?? 0) + (win?.height ?? 0)).toBe(892);
    actions.resize(id, 5000, 5000);
    expect(current(id)).toMatchObject({ x: 8, y: 8, width: 1184, height: 884 });
    window.innerWidth = 320;
    window.innerHeight = 480;
    actions.clampAll();
    expect(current(id)).toMatchObject({ x: 8, y: 8, width: 304, height: 464 });
    actions.resize(id, 1, 1);
    win = current(id);
    expect(win?.width).toBeGreaterThanOrEqual(240);
    expect(win?.height).toBeGreaterThanOrEqual(160);
    expect((win?.x ?? 0) + (win?.width ?? 0)).toBeLessThanOrEqual(312);
  });
});

describe("pinned reader reloads", () => {
  // A fresh import is intentional: pins are loaded at module initialization,
  // so a static import cannot exercise the reload/migration boundary.
  it("persists only pinned target and geometry, not transient ancestry or DOM state", async () => {
    const actions = store.getState();
    const parent = actions.open({ path: "parent.md" }, rect(), {
      mode: "reader",
    });
    const opener = document.createElement("button");
    const id = actions.open(
      { path: "a.md", heading: "Heading", blockId: "block-1" },
      rect(),
      { parentId: parent, opener, restricted: true },
    );
    actions.pin(id);
    actions.resize(id, 600, 500);
    actions.commitMove(id, 200, 150);
    actions.minimize(id);
    const persisted = window.localStorage.getItem("clp.preview.pinned") ?? "";
    expect(persisted).not.toContain("parentId");
    expect(persisted).not.toContain("opener");
    expect(persisted).not.toContain("focusRequest");
    expect(persisted).not.toContain("minimized");
    expect(persisted).not.toContain("parent.md");
    vi.resetModules();
    store = (await import("#/store/preview")).usePreviewStore;
    expect(store.getState().windows).toHaveLength(1);
    expect(store.getState().windows[0]).toMatchObject({
      path: "a.md",
      heading: "Heading",
      blockId: "block-1",
      mode: "reader",
      pinned: true,
      restricted: true,
      minimized: false,
      focusRequest: 0,
      x: 200,
      y: 150,
      width: 600,
      height: 500,
    });
    expect(store.getState().windows[0].parentId).toBeUndefined();
    expect(store.getState().windows[0].opener).toBeUndefined();
  });

  it("unpin leaves the current reader but excludes it from the next session", async () => {
    const actions = store.getState();
    const id = actions.open({ path: "a.md" }, rect());
    actions.pin(id);
    actions.unpin(id);
    expect(current(id)).toMatchObject({ mode: "reader", pinned: false });
    vi.resetModules();
    store = (await import("#/store/preview")).usePreviewStore;
    expect(store.getState().windows).toHaveLength(0);
  });

  it("keeps intermediate drag positions out of persisted geometry", async () => {
    const actions = store.getState();
    const id = actions.open({ path: "a.md" }, rect());
    actions.pin(id);
    const original = window.localStorage.getItem("clp.preview.pinned");
    actions.move(id, 150, 150);
    actions.move(id, 200, 200);
    expect(window.localStorage.getItem("clp.preview.pinned")).toBe(original);
    actions.commitMove(id, 220, 240);
    vi.resetModules();
    store = (await import("#/store/preview")).usePreviewStore;
    expect(store.getState().windows[0]).toMatchObject({ x: 220, y: 240 });
  });

  it("migrates valid legacy pins, rejects malformed entries and clamps to the current viewport", async () => {
    window.innerWidth = 400;
    window.innerHeight = 600;
    window.localStorage.setItem(
      "clp.preview.pinned",
      JSON.stringify([
        { path: "a.md", x: 900, y: 590, above: true },
        { path: "a.md", x: 10, y: 20 },
        { path: "b.md", x: -90, y: -90 },
        null,
        { path: "", x: 1, y: 2 },
        { path: "bad.md", x: "10", y: 10 },
      ]),
    );
    vi.resetModules();
    store = (await import("#/store/preview")).usePreviewStore;
    expect(store.getState().windows).toHaveLength(2);
    expect(store.getState().windows[0]).toMatchObject({
      path: "a.md",
      mode: "reader",
      pinned: true,
      x: 8,
      y: 30,
      width: 384,
      height: 560,
    });
    expect(store.getState().windows[1]).toMatchObject({
      path: "b.md",
      x: 8,
      y: 8,
    });
    expect(window.localStorage.getItem("clp.preview.pinned")).not.toContain(
      "above",
    );
    vi.resetModules();
    store = (await import("#/store/preview")).usePreviewStore;
    expect(store.getState().windows.map((win) => win.path)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it.each(["{broken", "null", "{}", '{"version":1,"windows":{}}'])(
    "ignores unusable saved state %s",
    async (value) => {
      window.localStorage.setItem("clp.preview.pinned", value);
      vi.resetModules();
      store = (await import("#/store/preview")).usePreviewStore;
      expect(store.getState().windows).toHaveLength(0);
    },
  );

  it("does not relax restricted rendering when an existing target is reused or reloaded", async () => {
    const actions = store.getState();
    const id = actions.open({ path: "a.md" }, rect(), { mode: "reader" });
    actions.pin(id);
    expect(actions.open({ path: "a.md" }, rect(), { restricted: true })).toBe(
      id,
    );
    actions.open({ path: "a.md" }, rect(), {
      mode: "reader",
      restricted: false,
    });
    expect(current(id)?.restricted).toBe(true);
    vi.resetModules();
    store = (await import("#/store/preview")).usePreviewStore;
    expect(store.getState().windows[0]?.restricted).toBe(true);
  });
});
