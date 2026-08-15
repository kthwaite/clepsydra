import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinkPreviewLayer } from "#/components/codex/LinkPreviewLayer";
import { usePreviewStore } from "#/store/preview";

const {
  baseProjectionState,
  openTabMock,
  pageState,
  previewBodyMock,
  toastErrorMock,
  usePageBasePropertiesMock,
} = vi.hoisted(() => ({
  baseProjectionState: {
    data: undefined as
      | { preview: { fields: unknown[]; remaining_count: number } }
      | undefined,
    isPending: true,
    isError: false,
  },
  openTabMock: vi.fn(),
  pageState: {
    data: undefined as
      | {
          meta: { id: string; title: string };
          body: string;
          encrypted?: boolean;
        }
      | undefined,
  },
  previewBodyMock: vi.fn(),
  toastErrorMock: vi.fn(),
  usePageBasePropertiesMock: vi.fn(),
}));

vi.mock("#/api/bases", () => ({
  usePageBaseProperties: (uuid: string) => {
    usePageBasePropertiesMock(uuid);
    return baseProjectionState;
  },
}));
vi.mock("#/api/index", () => ({ useBacklinks: () => ({ data: [] }) }));
vi.mock("#/api/pages", () => ({ usePage: () => pageState }));
vi.mock("#/components/codex/PreviewBody", () => ({
  PreviewBody: (props: unknown) => {
    previewBodyMock(props);
    return null;
  },
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => openTabMock }));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

function previewWindow(pinned = true) {
  return {
    id: "pinned-target",
    path: "notes/target.md",
    x: 30,
    y: 40,
    pinned,
    minimized: false,
    z: 202,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  pageState.data = {
    meta: { id: "page-target", title: "Target" },
    body: "",
  };
  baseProjectionState.data = undefined;
  baseProjectionState.isPending = true;
  baseProjectionState.isError = false;
  openTabMock.mockReset();
  previewBodyMock.mockReset();
  toastErrorMock.mockReset();
  usePageBasePropertiesMock.mockReset();
  usePreviewStore.setState({
    windows: [previewWindow()],
    topZ: 202,
    hoverId: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("waits for page identity and forwards passive projection states", () => {
  pageState.data = undefined;
  const view = render(<LinkPreviewLayer />);

  expect(usePageBasePropertiesMock).toHaveBeenLastCalledWith("");
  expect(previewBodyMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      preview: undefined,
      previewPending: true,
      previewError: false,
    }),
  );

  pageState.data = {
    meta: { id: "page-target", title: "Target" },
    body: "",
  };
  baseProjectionState.data = {
    preview: { fields: [], remaining_count: 0 },
  };
  baseProjectionState.isPending = false;
  view.rerender(<LinkPreviewLayer />);

  expect(usePageBasePropertiesMock).toHaveBeenLastCalledWith("page-target");
  expect(previewBodyMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      preview: baseProjectionState.data.preview,
      previewPending: false,
      previewError: false,
    }),
  );

  baseProjectionState.data = undefined;
  baseProjectionState.isError = true;
  view.rerender(<LinkPreviewLayer />);
  expect(previewBodyMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ previewError: true }),
  );
  expect(toastErrorMock).not.toHaveBeenCalled();
});

it("retains open navigation and transient hover cancellation", () => {
  vi.useFakeTimers();
  usePreviewStore.setState({
    windows: [previewWindow(false)],
    hoverId: "pinned-target",
  });
  render(<LinkPreviewLayer />);

  fireEvent.click(screen.getByRole("button", { name: "open" }));
  expect(openTabMock).toHaveBeenCalledWith(
    "page",
    "notes/target.md",
    "Target",
  );

  const card = document.querySelector<HTMLElement>(".fixed.cursor-default");
  expect(card).not.toBeNull();
  fireEvent.mouseLeave(card as HTMLElement);
  fireEvent.mouseEnter(card as HTMLElement);
  act(() => vi.advanceTimersByTime(200));
  expect(usePreviewStore.getState().windows).toHaveLength(1);
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
});
