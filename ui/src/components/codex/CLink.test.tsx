import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLink } from "#/components/codex/CLink";
import { PreviewContext } from "#/components/codex/PreviewContext";
import type { PreviewWindow } from "#/store/preview";
import { usePreviewStore } from "#/store/preview";

const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

const matching: PreviewWindow = {
  id: "matching",
  path: "notes/target.md",
  mode: "reader",
  focusRequest: 0,
  width: 360,
  height: 440,
  x: 8,
  y: 20,
  pinned: true,
  minimized: true,
  maximized: false,
  z: 201,
};
const unrelated: PreviewWindow = {
  id: "unrelated",
  path: "notes/other.md",
  mode: "reader",
  focusRequest: 0,
  width: 360,
  height: 440,
  x: 30,
  y: 40,
  pinned: true,
  minimized: false,
  maximized: false,
  z: 202,
};
let windowsAtOpen: PreviewWindow[] | undefined;

beforeEach(() => {
  openTabMock.mockReset();
  windowsAtOpen = undefined;
  openTabMock.mockImplementation(() => {
    windowsAtOpen = usePreviewStore.getState().windows;
  });
  usePreviewStore.setState({
    windows: [matching, unrelated],
    topZ: 202,
  });
});

describe("CLink navigation", () => {
  it("navigates with the keyboard without an adjacent Preview control", async () => {
    const user = userEvent.setup();
    render(<CLink path="notes/keyboard.md">Keyboard</CLink>);
    await user.tab();
    expect(screen.getByRole("link", { name: "Keyboard" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/keyboard.md");
  });

  it("cancels a pending hover when its link unmounts", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<CLink path="notes/stale.md">Stale</CLink>);
      fireEvent.mouseEnter(screen.getByRole("link", { name: "Stale" }));
      unmount();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(
        usePreviewStore
          .getState()
          .windows.some(
            (win) => "path" in win && win.path === "notes/stale.md",
          ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a hover peek without requesting focus", () => {
    vi.useFakeTimers();
    try {
      render(<CLink path="notes/hover.md">Hover</CLink>);
      fireEvent.mouseEnter(screen.getByRole("link", { name: "Hover" }));
      act(() => {
        vi.advanceTimersByTime(220);
      });
      expect(usePreviewStore.getState().windows).toContainEqual(
        expect.objectContaining({
          path: "notes/hover.md",
          mode: "peek",
          focusRequest: 0,
        }),
      );
      expect(openTabMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the matching preview before opening its page", async () => {
    const user = userEvent.setup();
    render(<CLink path="notes/target.md">Target</CLink>);

    await user.click(screen.getByRole("link", { name: "Target" }));

    expect(windowsAtOpen).toEqual([unrelated]);
    expect(usePreviewStore.getState().windows).toEqual([unrelated]);
    expect(openTabMock).toHaveBeenCalledOnce();
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
  });

  it("follows references as child readers without replacing the parent", async () => {
    const user = userEvent.setup();
    render(
      <PreviewContext value="matching">
        <CLink path="notes/child.md">Child</CLink>
      </PreviewContext>,
    );
    await user.click(screen.getByRole("link", { name: "Child" }));
    expect(usePreviewStore.getState().windows).toContainEqual(
      expect.objectContaining({
        path: "notes/child.md",
        parentId: "matching",
        mode: "reader",
      }),
    );
    expect(
      usePreviewStore.getState().windows.some((win) => win.id === "matching"),
    ).toBe(true);
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it("follows A to B to C and returns to A without an ancestry cycle", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <PreviewContext value="matching">
        <CLink path="notes/b.md">B</CLink>
      </PreviewContext>,
    );
    await user.click(screen.getByRole("link", { name: "B" }));
    const b = usePreviewStore
      .getState()
      .windows.find((win) => "path" in win && win.path === "notes/b.md");
    expect(b).toBeDefined();
    rerender(
      <PreviewContext value={b?.id}>
        <CLink path="notes/c.md">C</CLink>
      </PreviewContext>,
    );
    await user.click(screen.getByRole("link", { name: "C" }));
    const c = usePreviewStore
      .getState()
      .windows.find((win) => "path" in win && win.path === "notes/c.md");
    expect(c?.parentId).toBe(b?.id);
    rerender(
      <PreviewContext value={c?.id}>
        <CLink path="notes/target.md">A</CLink>
      </PreviewContext>,
    );
    await user.click(screen.getByRole("link", { name: "A" }));
    const a = usePreviewStore
      .getState()
      .windows.find((win) => win.id === "matching");
    expect(a?.parentId).toBeUndefined();
    expect(
      usePreviewStore
        .getState()
        .windows.filter(
          (win) => "path" in win && win.path === "notes/target.md",
        ),
    ).toHaveLength(1);
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it("preserves the passage on ordinary navigation", async () => {
    const user = userEvent.setup();
    render(
      <CLink target={{ path: "notes/target.md", heading: "Details" }}>
        Details
      </CLink>,
    );
    await user.click(screen.getByRole("link", { name: "Details" }));
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/target.md",
      undefined,
      { heading: "Details" },
    );
  });
});

describe("CLink payload card", () => {
  it("shows the folio and counts in sentence case", async () => {
    const user = userEvent.setup();
    render(
      <CLink
        payload={{
          title: "The float valve",
          folio: "k3Qz8mTa",
          words: 412,
          backlinks: 1,
          tags: ["horology", "design"],
        }}
      >
        Valve
      </CLink>,
    );

    await user.hover(screen.getByRole("link", { name: /Valve/ }));

    expect(screen.getByText("k3Qz8mTa")).toBeInTheDocument();
    expect(screen.getByText("412 words · 1 backlink")).toBeInTheDocument();
    expect(screen.getByText("#horology · #design")).toBeInTheDocument();
  });
});
