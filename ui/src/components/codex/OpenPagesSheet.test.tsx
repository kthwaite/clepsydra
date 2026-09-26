import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(async () => {
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});

const { activateMock, openInscribeMock } = vi.hoisted(() => ({
  activateMock: vi.fn(),
  openInscribeMock: vi.fn(),
}));

vi.mock("#/hooks/useFolioHistoryNavigation", () => ({
  useActivateTabWithFolioHistory: () => activateMock,
}));
vi.mock("#/store/ui", () => ({
  useUiStore: (sel: (s: { openInscribe: () => void }) => unknown) =>
    sel({ openInscribe: openInscribeMock }),
}));

import { OpenPagesSheet } from "#/components/codex/OpenPagesSheet";
import { useWorkspaceStore } from "#/store/workspace";

const tab = (id: string, label: string, quireId?: string) => ({
  id,
  type: "page" as const,
  path: `notes/${id}.md`,
  label,
  ...(quireId ? { quireId } : {}),
});

function seed() {
  useWorkspaceStore.setState({
    tabs: [
      tab("a", "Ctesibius", "q1"),
      tab("b", "Hero of Alexandria", "q1"),
      tab("c", "Friday 25 September"),
      tab("d", "Orphan", "gone"),
    ],
    activeTabId: "a",
    quires: {
      q1: { id: "q1", name: "Research", color: "ochre", collapsed: true },
    },
  });
}

describe("OpenPagesSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("groups pages by quire with loose and orphaned tabs under Ungrouped", () => {
    render(<OpenPagesSheet isOpen onOpenChange={() => {}} />);
    const research = screen.getByRole("group", { name: "Research" });
    expect(
      within(research).getByRole("button", { name: "Ctesibius" }),
    ).toBeVisible();
    expect(
      within(research).getByRole("button", { name: "Hero of Alexandria" }),
    ).toBeVisible();
    const loose = screen.getByRole("group", { name: "Ungrouped" });
    expect(
      within(loose).getByRole("button", { name: "Friday 25 September" }),
    ).toBeVisible();
    expect(within(loose).getByRole("button", { name: "Orphan" })).toBeVisible();
  });

  it("marks the active page", () => {
    render(<OpenPagesSheet isOpen onOpenChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Ctesibius" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Orphan" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("activates a page and closes the sheet", async () => {
    const onOpenChange = vi.fn();
    render(<OpenPagesSheet isOpen onOpenChange={onOpenChange} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Hero of Alexandria" }),
    );
    expect(activateMock).toHaveBeenCalledWith("b");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes one page", async () => {
    render(<OpenPagesSheet isOpen onOpenChange={() => {}} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Close Hero of Alexandria" }),
    );
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("closes all pages only after confirming", async () => {
    render(<OpenPagesSheet isOpen onOpenChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Close all" }));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(4);
    expect(
      screen.getByText("Close every tab and dissolve all quires?"),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Close all tabs" }),
    );
    expect(useWorkspaceStore.getState().tabs).toEqual([]);
  });

  it("keeps every page when Close all is cancelled", async () => {
    render(<OpenPagesSheet isOpen onOpenChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Close all" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Close all" })).toBeVisible();
  });

  it("offers New page when nothing is open", async () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, quires: {} });
    const onOpenChange = vi.fn();
    render(<OpenPagesSheet isOpen onOpenChange={onOpenChange} />);
    expect(screen.getByText("No open pages.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Close all" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New page" }));
    expect(openInscribeMock).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
