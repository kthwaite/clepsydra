import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "#/store/ui";
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

beforeEach(() => {
  useUiStore.setState({ isInscribeOpen: false });
});

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

  it("an active quire member renders both the quire and active rules", () => {
    seed(false);
    useWorkspaceStore.setState({ activeTabId: "t1" });
    render(<Sheaf activeTabId="t1" />);
    const tabButton = screen.getByRole("button", { name: "Alpha" });
    expect(tabButton.style.boxShadow).toContain("var(--quire-sepia)");
    expect(tabButton.style.boxShadow).toContain("var(--accent)");
  });

  it("clicking the label toggles collapse in the store", async () => {
    seed(false);
    const user = userEvent.setup();
    render(<Sheaf activeTabId="t3" />);
    await user.click(screen.getByRole("button", { name: /quire thesis/i }));
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(true);
  });

  it("keeps activation and close controls without tab pin controls", async () => {
    const user = userEvent.setup();
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    expect(
      screen.queryByRole("button", { name: /pin folio/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "close folio" }),
    ).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Alpha" }));
    expect(useWorkspaceStore.getState().activeTabId).toBe("t1");
  });
});

describe("Sheaf creation action", () => {
  it("opens the existing Intake page-creation dialog state", async () => {
    const user = userEvent.setup();
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(useUiStore.getState().isInscribeOpen).toBe(true);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(3);
  });

  it("does not represent the creation action as a sheaf tab", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New page" }),
    ).not.toHaveAttribute("aria-selected");
  });

  it("keeps duplicate activation idempotent", async () => {
    const user = userEvent.setup();
    seed(false);
    render(<Sheaf activeTabId="t3" />);

    await user.dblClick(screen.getByRole("button", { name: "New page" }));

    expect(useUiStore.getState().isInscribeOpen).toBe(true);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "New page" })).toHaveLength(1);
  });
});
