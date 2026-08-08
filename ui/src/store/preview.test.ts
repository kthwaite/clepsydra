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
