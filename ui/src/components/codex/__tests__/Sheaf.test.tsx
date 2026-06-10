import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "#/store/workspace";
import { Sheaf } from "../Sheaf";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));
vi.mock("#/api/index", () => ({
  useStats: () => ({ data: undefined }),
}));
vi.mock("#/components/codex/TabPreviewCard", () => ({
  TabPreviewCard: () => null,
}));

function seed(collapsed: boolean) {
  useWorkspaceStore.setState({
    tabs: [
      { id: "t1", type: "page", path: "a.md", label: "Alpha", quireId: "q1" },
      { id: "t2", type: "page", path: "b.md", label: "Beta", quireId: "q1" },
      { id: "t3", type: "page", path: "c.md", label: "Gamma" },
    ],
    activeTabId: "t3",
    quires: { q1: { id: "q1", name: "thesis", color: "sepia", collapsed } },
    openHistory: [],
  });
}

describe("Sheaf quire rendering", () => {
  it("renders the quire label cell before its member tabs", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    expect(
      screen.getByRole("button", { name: /quire thesis/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("hides member tabs and shows the count when collapsed", () => {
    seed(true);
    render(<Sheaf activeTabId="t3" />);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("·2")).toBeInTheDocument();
  });

  it("counts hidden members in the SHEAF total", () => {
    seed(true);
    render(<Sheaf activeTabId="t3" />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("clicking the label toggles collapse in the store", async () => {
    seed(false);
    const user = userEvent.setup();
    render(<Sheaf activeTabId="t3" />);
    await user.click(screen.getByRole("button", { name: /quire thesis/i }));
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(true);
  });
});
