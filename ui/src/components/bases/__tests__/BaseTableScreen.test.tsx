import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BaseDetailResponse,
  BaseMemberCapability,
  QueryOutput,
} from "#/api/bases";
import { BaseTableView } from "#/components/bases/BaseTableView";
import type { BaseMemberDraftField } from "#/components/bases/member-draft";
import { EMPTY_OVERRIDES } from "#/components/bases/view-overrides";
import { FooterControlsHost } from "#/components/codex/FooterControls";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params: { slug: string };
    [key: string]: unknown;
  }) => (
    <a {...props} href={to.replace("$slug", params.slug)}>
      {children}
    </a>
  ),
}));

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "revision-1",
  name: "Reading Log",
  properties: [
    { key: "author", definition: { type: "text" } },
    { key: "rating", definition: { type: "number" } },
    {
      key: "status",
      definition: { type: "select", options: ["queued", "reading"] },
    },
  ],
  views: [
    { name: "Continues", layout: "table", columns: ["title", "author"] },
    {
      name: "Shelf",
      layout: "table",
      group_by: "status",
      aggregates: [{ fn: "count" }, { fn: "avg", field: "rating" }],
      columns: ["title", "rating"],
    },
  ],
  diagnostics: [],
  member_creation: [],
};

const row = {
  id: "01",
  path: "book.md",
  title: "The Book of the New Sun",
  kind: "BOOK",
  columns: { author: "Gene Wolfe", rating: 4.5, status: "reading" },
};

const flat: QueryOutput = {
  shape: "flat",
  rows: [row],
  total: 1,
  aggregates: [],
};

const enabledCapability: BaseMemberCapability = {
  view: "Continues",
  enabled: true,
  fields: [],
  blockers: [],
};

const memberDraftFields: BaseMemberDraftField[] = [
  {
    key: "title",
    kind: "title",
    membership: true,
    viewOnly: false,
    embedOnly: false,
  },
];

type ViewProps = Parameters<typeof BaseTableView>[0];

function renderScreen(props: Partial<ViewProps> = {}) {
  const spies = {
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    onCommitCell: vi.fn(),
    onAddMember: vi.fn(),
    onAddQuickFilter: vi.fn(),
    onSetGroup: vi.fn(),
    onHideColumn: vi.fn(),
    onShowColumn: vi.fn(),
    onShowHiddenColumns: vi.fn(),
  };
  render(
    <>
      <BaseTableView
        definition={definition}
        activeView="Continues"
        output={flat}
        sort={undefined}
        configureSlug="reading"
        memberCapability={enabledCapability}
        memberDraftFields={memberDraftFields}
        memberDraftOpen={false}
        memberSaving={false}
        memberDiagnostics={[]}
        projects={[]}
        overrides={EMPTY_OVERRIDES}
        screen
        {...spies}
        {...props}
      />
      <FooterControlsHost />
    </>,
  );
  return spies;
}

beforeEach(() => localStorage.clear());

describe("Bases screen chrome", () => {
  it("titles the base in serif under a Base eyebrow with its row count", () => {
    renderScreen();
    expect(
      screen.getByRole("heading", { level: 1, name: "Reading Log" }),
    ).toHaveClass("font-serif");
    expect(screen.getByText("Base")).toBeVisible();
    expect(screen.getAllByText("1 row")[0]).toBeVisible();
  });

  it("starts comfortable and remembers the Compact switch", async () => {
    renderScreen();
    const sw = screen.getByRole("switch", { name: "Compact" });
    expect(sw).not.toBeChecked();
    await userEvent.setup().click(sw);
    expect(sw).toBeChecked();
    expect(localStorage.getItem("clepsydra.tableCompact.bases")).toBe("true");
  });

  it("puts the file path and row count in the footer", () => {
    renderScreen();
    const footer = document.querySelector('[data-slot="footer-controls"]');
    expect(footer).toHaveTextContent("bases/reading.base.toml");
    expect(footer).toHaveTextContent("1 row");
  });

  it("offers Filter, Sort and Group pickers in the view bar", async () => {
    const user = userEvent.setup();
    const spies = renderScreen();
    await user.click(screen.getByRole("button", { name: "Sort" }));
    await user.click(await screen.findByRole("menuitem", { name: "author" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Descending" }),
    );
    expect(spies.onSortChange).toHaveBeenCalledWith([
      { field: "author", dir: "desc" },
    ]);
    expect(screen.getByRole("button", { name: "Filter" })).toBeVisible();
  });

  it("names the saved view's grouping on the Group pill", () => {
    renderScreen({ activeView: "Shelf" });
    expect(
      screen.getByRole("button", { name: "Group · status" }),
    ).toBeVisible();
  });

  it("counts filter overrides on the Filter pill", () => {
    renderScreen({
      overrides: {
        ...EMPTY_OVERRIDES,
        quickFilters: [
          {
            field: "status",
            op: "eq",
            value: "reading",
            label: "status is reading",
          },
        ],
      },
    });
    expect(screen.getByRole("button", { name: "Filter · 1" })).toBeVisible();
  });

  it("keeps the views as a navigation with the active view current", () => {
    renderScreen();
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(
      within(views).getByRole("button", { name: "Continues" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows no pickers when read-only", () => {
    renderScreen({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
  });
});

describe("embedded chrome", () => {
  for (const chrome of ["compact", "full"] as const) {
    it(`keeps screen chrome out of a ${chrome} embed`, () => {
      renderScreen({ screen: undefined, chrome });
      expect(screen.queryByRole("switch", { name: "Compact" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
      expect(screen.queryByText("Base")).toBeNull();
      expect(
        document.querySelector('[data-slot="footer-controls"]'),
      ).toBeEmptyDOMElement();
    });
  }
});

describe("Bases table density", () => {
  it("renders comfortable rows on the screen by default and compact on request", async () => {
    renderScreen();
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("data-density", "comfortable");
    await userEvent
      .setup()
      .click(screen.getByRole("switch", { name: "Compact" }));
    expect(screen.getByRole("grid")).toHaveAttribute("data-density", "compact");
  });

  it("renders embeds dense", () => {
    renderScreen({ screen: undefined, chrome: "compact" });
    expect(screen.getByRole("grid")).toHaveAttribute("data-density", "compact");
  });

  it("shows sentence-case headers and arrows, not caps and triangles", () => {
    renderScreen({ sort: [{ field: "author", dir: "desc" }] });
    const header = screen.getByRole("columnheader", { name: /author/ });
    expect(header).toHaveTextContent("↓");
    expect(header).not.toHaveTextContent("▼");
  });
});
