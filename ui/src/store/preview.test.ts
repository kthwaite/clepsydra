import { beforeEach, describe, expect, it } from "vitest";
import { type PreviewWindow, usePreviewStore } from "#/store/preview";

const windows: PreviewWindow[] = [
  {
    id: "hover-target",
    path: "notes/target.md",
    x: 8,
    y: 20,
    pinned: false,
    minimized: false,
    z: 201,
  },
  {
    id: "pinned-target",
    path: "notes/target.md",
    x: 30,
    y: 40,
    pinned: true,
    minimized: true,
    z: 202,
  },
  {
    id: "other",
    path: "notes/other.md",
    x: 50,
    y: 60,
    pinned: true,
    minimized: false,
    z: 203,
  },
];

beforeEach(() => {
  window.localStorage.clear();
  usePreviewStore.setState({ windows: [], topZ: 200, hoverId: null });
});

describe("closePath", () => {
  it("closes every matching preview and preserves unrelated pinned state", () => {
    usePreviewStore.setState({ windows, hoverId: "hover-target" });

    usePreviewStore.getState().closePath("notes/target.md");

    expect(usePreviewStore.getState().windows).toEqual([windows[2]]);
    expect(usePreviewStore.getState().hoverId).toBeNull();
    expect(window.localStorage.getItem("clp.preview.pinned")).toBe(
      JSON.stringify([{ path: "notes/other.md", x: 50, y: 60 }]),
    );
  });

  it("is a no-op when no preview matches", () => {
    usePreviewStore.setState({ windows: [windows[2]], hoverId: null });

    usePreviewStore.getState().closePath("notes/missing.md");

    expect(usePreviewStore.getState().windows).toEqual([windows[2]]);
    expect(usePreviewStore.getState().hoverId).toBeNull();
  });
});

describe("preview movement persistence", () => {
  it("keeps transient moves in memory and persists only final coordinates", () => {
    usePreviewStore.setState({ windows: [windows[1]], hoverId: null });
    const actions = usePreviewStore.getState();

    actions.move("pinned-target", 80, 90);
    actions.move("pinned-target", 120, 140);

    expect(window.localStorage.getItem("clp.preview.pinned")).toBeNull();
    actions.commitMove("pinned-target", 120, 140);
    expect(window.localStorage.getItem("clp.preview.pinned")).toBe(
      JSON.stringify([{ path: "notes/target.md", x: 120, y: 140 }]),
    );
  });
});

describe("openHover placement", () => {
  const rectAt = (top: number) =>
    ({ left: 100, top, bottom: top + 20 }) as DOMRect;

  it("opens below a link in the top half of the viewport", () => {
    window.innerHeight = 800;
    usePreviewStore.getState().openHover("notes/a.md", rectAt(200));

    const [win] = usePreviewStore.getState().windows;
    expect(win.above).toBeFalsy();
    expect(win.y).toBe(226);
  });

  it("opens above a link in the bottom half, anchored by its bottom edge", () => {
    window.innerHeight = 800;
    usePreviewStore.getState().openHover("notes/a.md", rectAt(600));

    const [win] = usePreviewStore.getState().windows;
    expect(win.above).toBe(true);
    expect(win.y).toBe(594);
  });

  it("drops the above anchor once moved, since moves are top-left", () => {
    window.innerHeight = 800;
    const actions = usePreviewStore.getState();
    actions.openHover("notes/a.md", rectAt(600));
    const [win] = usePreviewStore.getState().windows;

    actions.move(win.id, 10, 20);

    expect(usePreviewStore.getState().windows[0].above).toBe(false);
  });

  it("persists the above anchor for a pinned, unmoved window", () => {
    window.innerHeight = 800;
    const actions = usePreviewStore.getState();
    actions.openHover("notes/a.md", rectAt(600));
    const [win] = usePreviewStore.getState().windows;

    actions.pin(win.id);

    expect(window.localStorage.getItem("clp.preview.pinned")).toBe(
      JSON.stringify([{ path: "notes/a.md", x: 100, y: 594, above: true }]),
    );
  });
});
