import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLink } from "#/components/codex/CLink";
import type { PreviewWindow } from "#/store/preview";
import { usePreviewStore } from "#/store/preview";

const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

const matching: PreviewWindow = {
  id: "matching",
  path: "notes/target.md",
  x: 8,
  y: 20,
  pinned: true,
  minimized: true,
  z: 201,
};
const unrelated: PreviewWindow = {
  id: "unrelated",
  path: "notes/other.md",
  x: 30,
  y: 40,
  pinned: true,
  minimized: false,
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
    hoverId: null,
  });
});

describe("CLink navigation", () => {
  it("closes the matching preview before opening its page", async () => {
    const user = userEvent.setup();
    render(<CLink path="notes/target.md">Target</CLink>);

    await user.click(screen.getByRole("link", { name: "Target" }));

    expect(windowsAtOpen).toEqual([unrelated]);
    expect(usePreviewStore.getState().windows).toEqual([unrelated]);
    expect(openTabMock).toHaveBeenCalledOnce();
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
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
