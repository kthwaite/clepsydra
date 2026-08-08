import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LinkPreviewLayer } from "#/components/codex/LinkPreviewLayer";
import { usePreviewStore } from "#/store/preview";

vi.mock("#/api/index", () => ({ useBacklinks: () => ({ data: [] }) }));
vi.mock("#/api/pages", () => ({
  usePage: () => ({ data: { meta: { title: "Target" }, body: "" } }),
}));
vi.mock("#/components/codex/PreviewBody", () => ({
  PreviewBody: () => null,
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

beforeEach(() => {
  window.localStorage.clear();
  usePreviewStore.setState({
    windows: [
      {
        id: "pinned-target",
        path: "notes/target.md",
        x: 30,
        y: 40,
        pinned: true,
        minimized: false,
        z: 202,
      },
    ],
    topZ: 202,
    hoverId: null,
  });
});

it("persists a dragged preview only when the pointer is released", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  render(<LinkPreviewLayer />);
  const titlebar = document.querySelector<HTMLElement>(".cursor-grab");
  expect(titlebar).not.toBeNull();

  fireEvent.pointerDown(titlebar as HTMLElement, { clientX: 40, clientY: 50 });
  fireEvent.pointerMove(window, { clientX: 150, clientY: 180 });
  act(() => frames[0]?.(0));

  expect(window.localStorage.getItem("clp.preview.pinned")).toBeNull();
  fireEvent.pointerUp(window);
  expect(window.localStorage.getItem("clp.preview.pinned")).toBe(
    JSON.stringify([{ path: "notes/target.md", x: 140, y: 170 }]),
  );
  expect(titlebar?.parentElement).toHaveStyle({
    transform: "translate3d(140px, 170px, 0)",
  });
  vi.unstubAllGlobals();
});
