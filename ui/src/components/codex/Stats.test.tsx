import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statsMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useContentIndex: vi.fn(() => ({
    data: {
      items: [
        {
          path: "notes/garden.md",
          title: "Garden notes",
          tags: ["garden"],
          created_at: null,
          updated_at: null,
        },
        {
          path: "inbox/unfiled.md",
          title: "Unfiled note",
          tags: [],
          created_at: null,
          updated_at: null,
        },
      ],
    },
  })),
  useReferenceIssues: vi.fn(() => ({
    data: { items: [], total: 23, limit: 1, offset: 0 },
  })),
  lastIndexedAt: null as string | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => statsMocks.navigate,
}));

vi.mock("#/api/index", () => ({
  useStats: () => ({
    data: {
      pages: 1_234,
      links_total: 5_678,
      links_unresolved: 12,
      tags: 19,
      orphan_pages: 3,
      isolated_pages: 2,
      attachments: 44,
      last_indexed_at: statsMocks.lastIndexedAt,
    },
  }),
  useTags: () => ({
    data: [
      { tag: "reading", count: 4 },
      { tag: "garden", count: 9 },
      { tag: "singleton", count: 1 },
    ],
  }),
  useContentIndex: statsMocks.useContentIndex,
  useReferenceIssues: statsMocks.useReferenceIssues,
}));

import { Stats } from "#/components/codex/Stats";

function closestSection(element: HTMLElement): HTMLElement {
  const section = element.closest("section");
  if (!section) throw new Error("Expected content inside a section");
  return section;
}

function expectInventoryCell(
  inventory: HTMLElement,
  label: string,
  value: string,
) {
  const labelElement = within(inventory).getByText(label);
  const cell = labelElement.parentElement;
  if (!cell) throw new Error(`Expected an inventory cell for ${label}`);
  expect(within(cell).getByText(value)).toBeInTheDocument();
}

describe("Stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statsMocks.lastIndexedAt = null;
  });

  it("titles the page with a Vault eyebrow and a Stats heading", () => {
    render(<Stats />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Stats" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Vault")).toBeInTheDocument();
    expect(screen.queryByText(/last collated/)).toBeNull();
  });

  it("names when the index was last collated, when the index says", () => {
    statsMocks.lastIndexedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<Stats />);

    expect(
      screen.getByText("Counts from the index, last collated 5m ago"),
    ).toBeInTheDocument();
  });

  it("renders the vault inventory derived from stats and content", () => {
    render(<Stats />);

    const inventory = closestSection(
      screen.getByRole("heading", { name: "Inventory" }),
    );
    for (const [label, value] of [
      ["Notes", "1,234"],
      ["Links", "5,678"],
      ["Tags", "19"],
      ["Unresolved", "12"],
      ["Orphans", "3"],
      ["Isolated", "2"],
      ["Attachments", "44"],
      ["Captured today", "0"],
      ["Edited today", "0"],
      ["New this week", "0"],
      ["Unfiled", "1"],
    ]) {
      expectInventoryCell(inventory, label, value);
    }
    expect(statsMocks.useContentIndex).toHaveBeenCalledWith({ limit: 500 });
  });

  it("lists subjects by frequency and opens the selected Gazetteer tag", async () => {
    const user = userEvent.setup();
    render(<Stats />);

    const subjects = closestSection(screen.getByText("Subjects, by frequency"));
    expect(within(subjects).getByText("All 3 tags")).toBeInTheDocument();
    const garden = within(subjects).getByRole("button", {
      name: /#garden.*9/i,
    });
    const reading = within(subjects).getByRole("button", {
      name: /#reading.*4/i,
    });

    expect(
      garden.compareDocumentPosition(reading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(reading);

    expect(statsMocks.navigate).toHaveBeenCalledWith({
      to: "/gazetteer",
      search: { tags: ["reading"] },
    });
  });

  it("shows the current repair count and opens Reference Repairs", async () => {
    const user = userEvent.setup();
    render(<Stats />);

    expect(statsMocks.useReferenceIssues).toHaveBeenCalledWith({
      limit: 1,
      offset: 0,
    });
    const repairs = screen.getByRole("button", {
      name: "Open Reference Repairs, 23 issues",
    });
    expect(repairs).toHaveTextContent("23 reference issues");

    await user.click(repairs);

    expect(statsMocks.navigate).toHaveBeenCalledWith({ to: "/repairs" });
  });
});
