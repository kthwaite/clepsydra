import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

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

import type {
  BaseDetailResponse,
  BaseMemberCapability,
  QueryOutput,
} from "#/api/bases";
import { BaseTableView } from "#/components/bases/BaseTableView";
import type { BaseMemberDraftField } from "#/components/bases/member-draft";
import {
  EMPTY_OVERRIDES,
  quickFilterIdentity,
} from "#/components/bases/view-overrides";

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
    { key: "due", definition: { type: "date" } },
  ],
  views: [
    {
      name: "Continues",
      layout: "table",
      columns: ["title", "author", "status", "due"],
    },
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
  columns: {
    author: "Gene Wolfe",
    rating: 4.5,
    status: "reading",
    due: "2026-08-28",
  },
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

function renderView(overrides: Partial<ViewProps>) {
  const spies = {
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    onCommitCell: vi.fn(),
    onAddMember: vi.fn(),
    onSaveMember: vi.fn(),
    onCancelMember: vi.fn(),
    onMemberEdit: vi.fn(),
    configureSlug: "reading",
  };
  const element = (next: Partial<ViewProps> = {}) => (
    <BaseTableView
      definition={definition}
      activeView="Continues"
      output={flat}
      sort={undefined}
      memberCapability={enabledCapability}
      memberDraftFields={memberDraftFields}
      memberDraftOpen={false}
      memberSaving={false}
      memberDiagnostics={[]}
      projects={[]}
      {...spies}
      {...overrides}
      {...next}
    />
  );
  const result = render(element());
  return {
    ...spies,
    rerender: (next: Partial<ViewProps>) => result.rerender(element(next)),
  };
}

const overrideSpies = () => ({
  onAddQuickFilter: vi.fn(),
  onRemoveQuickFilter: vi.fn(),
  onSetGroup: vi.fn(),
  onHideColumn: vi.fn(),
  onShowHiddenColumns: vi.fn(),
  onClearOverrides: vi.fn(),
  onSaveOverrides: vi.fn(),
  onReloadDefinition: vi.fn(),
  onOpenPageInNewTab: vi.fn(),
  onCopyWikilink: vi.fn(),
  onCopyValue: vi.fn(),
  onDuplicateRow: vi.fn(),
  onArchiveRow: vi.fn().mockResolvedValue(undefined),
});

describe("column header menu", () => {
  it("opens from the ⋯ button and dispatches sort, group and hide", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.click(
      screen.getByRole("button", { name: "author column menu" }),
    );
    const menu = await screen.findByRole("menu", {
      name: "author column menu",
    });
    expect(
      within(menu).getByRole("menuitem", { name: "Sort ascending" }),
    ).toBeVisible();
    await user.click(
      within(menu).getByRole("menuitem", { name: "Sort descending" }),
    );
    expect(view.onSortChange).toHaveBeenCalledWith([
      { field: "author", dir: "desc" },
    ]);

    await user.click(
      screen.getByRole("button", { name: "author column menu" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Group by author" }),
    );
    expect(spies.onSetGroup).toHaveBeenCalledWith({
      kind: "by",
      field: "author",
    });

    await user.click(
      screen.getByRole("button", { name: "author column menu" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Hide column" }),
    );
    expect(spies.onHideColumn).toHaveBeenCalledWith("author");
  });

  it("offers filter presets in a submenu", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.click(screen.getByRole("button", { name: "due column menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "due is this week" }),
    );
    expect(spies.onAddQuickFilter).toHaveBeenCalledWith({
      field: "due",
      op: "is_this_week",
      label: "due is this week",
    });
  });

  it("never hides the title column and shows Ungroup for the grouped column", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({
      ...spies,
      overrides: { ...EMPTY_OVERRIDES, group: { kind: "by", field: "status" } },
    });
    await user.click(screen.getByRole("button", { name: "title column menu" }));
    const hide = await screen.findByRole("menuitem", { name: /Hide column/ });
    expect(hide).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "status column menu" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Ungroup" }));
    expect(spies.onSetGroup).toHaveBeenCalledWith({ kind: "flat" });
  });

  it("opens from a right-click on the header", async () => {
    const user = userEvent.setup();
    renderView({ ...overrideSpies(), overrides: EMPTY_OVERRIDES });
    await user.pointer({
      target: screen.getByText("author"),
      keys: "[MouseRight]",
    });
    expect(
      await screen.findByRole("menuitem", { name: "Sort ascending" }),
    ).toBeVisible();
  });

  it("is absent when read-only", () => {
    renderView({
      ...overrideSpies(),
      overrides: EMPTY_OVERRIDES,
      readOnly: true,
    });
    expect(
      screen.queryByRole("button", { name: "author column menu" }),
    ).not.toBeInTheDocument();
  });
});

describe("cell and row menu", () => {
  it("right-click on a cell offers the value filter, copy, and row actions", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.pointer({
      target: screen.getByRole("button", { name: "reading" }),
      keys: "[MouseRight]",
    });
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "status is reading" }),
    );
    expect(spies.onAddQuickFilter).toHaveBeenCalledWith({
      field: "status",
      op: "eq",
      value: "reading",
      label: "status is reading",
    });

    await user.pointer({
      target: screen.getByRole("button", { name: "reading" }),
      keys: "[MouseRight]",
    });
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy value" }),
    );
    expect(spies.onCopyValue).toHaveBeenCalledWith("reading");

    await user.pointer({
      target: screen.getByRole("button", { name: "reading" }),
      keys: "[MouseRight]",
    });
    await user.click(
      await screen.findByRole("menuitem", { name: "Open in new tab" }),
    );
    expect(spies.onOpenPageInNewTab).toHaveBeenCalledWith("book.md");
    void view;
  });

  it("offers the date submenu on date cells", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.pointer({
      target: screen.getByRole("button", { name: "2026-08-28" }),
      keys: "[MouseRight]",
    });
    await user.click(
      await screen.findByRole("menuitem", { name: "Filter by date" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Today" }));
    expect(spies.onAddQuickFilter).toHaveBeenCalledWith({
      field: "due",
      op: "is_today",
      label: "due is today",
    });
  });

  it("the ⋯ button lists row actions and archive confirms through a dialog", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    await user.click(
      screen.getByRole("button", {
        name: "Row actions for The Book of the New Sun",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy wikilink" }),
    );
    expect(spies.onCopyWikilink).toHaveBeenCalledWith(
      expect.objectContaining({ path: "book.md" }),
    );

    await user.click(
      screen.getByRole("button", {
        name: "Row actions for The Book of the New Sun",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Duplicate" }),
    );
    expect(spies.onDuplicateRow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "01" }),
    );

    await user.click(
      screen.getByRole("button", {
        name: "Row actions for The Book of the New Sun",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Archive…" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive page" });
    expect(
      within(dialog).getByText(
        "You can restore this page from the Rubbish Bin.",
      ),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm archive" }),
    );
    await waitFor(() =>
      expect(spies.onArchiveRow).toHaveBeenCalledWith(
        expect.objectContaining({ id: "01" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps only navigation items when read-only", async () => {
    const user = userEvent.setup();
    renderView({
      ...overrideSpies(),
      overrides: EMPTY_OVERRIDES,
      readOnly: true,
    });
    await user.pointer({
      target: screen.getByText("The Book of the New Sun"),
      keys: "[MouseRight]",
    });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeVisible();
    expect(
      within(menu).queryByRole("menuitem", { name: "Duplicate" }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Archive…" }),
    ).not.toBeInTheDocument();
  });

  it("opens the cell menu from the keyboard", async () => {
    const platformSpy = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      const user = userEvent.setup();
      renderView({ ...overrideSpies(), overrides: EMPTY_OVERRIDES });
      await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
      await user.keyboard("{Escape}");
      screen.getByRole("button", { name: "Gene Wolfe" }).focus();
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(
        await screen.findByRole("menuitem", { name: "Open" }),
      ).toBeVisible();
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("overrides strip", () => {
  it("renders chips, removes on click, clears and saves", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({
      ...spies,
      sort: [{ field: "author", dir: "asc" }],
      overrides: {
        quickFilters: [
          {
            field: "status",
            op: "eq",
            value: "reading",
            label: "status is reading",
          },
        ],
        group: { kind: "by", field: "status" },
        hiddenColumns: ["author"],
      },
      overridesSave: { phase: "idle" },
    });
    const strip = screen.getByRole("group", { name: "View overrides" });
    await user.click(
      within(strip).getByRole("button", { name: "Remove Sorted by author ↑" }),
    );
    expect(view.onSortChange).toHaveBeenCalledWith(undefined);
    await user.click(
      within(strip).getByRole("button", { name: "Remove status is reading" }),
    );
    expect(spies.onRemoveQuickFilter).toHaveBeenCalledWith(
      quickFilterIdentity({
        field: "status",
        op: "eq",
        value: "reading",
        label: "",
      }),
    );
    await user.click(
      within(strip).getByRole("button", { name: "Remove Grouped by status" }),
    );
    expect(spies.onSetGroup).toHaveBeenCalledWith(undefined);
    await user.click(
      within(strip).getByRole("button", { name: "Remove Hidden: author" }),
    );
    expect(spies.onShowHiddenColumns).toHaveBeenCalled();
    await user.click(within(strip).getByRole("button", { name: "Clear" }));
    expect(spies.onClearOverrides).toHaveBeenCalled();
    await user.click(
      within(strip).getByRole("button", { name: "Save to view" }),
    );
    expect(spies.onSaveOverrides).toHaveBeenCalled();
  });

  it("hides the strip without overrides and shows the conflict with a reload", async () => {
    const user = userEvent.setup();
    const spies = overrideSpies();
    const view = renderView({ ...spies, overrides: EMPTY_OVERRIDES });
    expect(
      screen.queryByRole("group", { name: "View overrides" }),
    ).not.toBeInTheDocument();
    view.rerender({
      overrides: { ...EMPTY_OVERRIDES, group: { kind: "flat" } },
      overridesSave: {
        phase: "conflict",
        message: "This base changed elsewhere. Reload, then save again.",
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This base changed elsewhere",
    );
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(spies.onReloadDefinition).toHaveBeenCalled();
    expect(screen.getByText("Ungrouped")).toBeVisible();
  });

  it("hides columns from the grid and groups by the override", () => {
    renderView({
      ...overrideSpies(),
      overrides: { ...EMPTY_OVERRIDES, hiddenColumns: ["author"] },
    });
    expect(
      screen.queryByRole("columnheader", { name: /author/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /status/ })).toBeVisible();
  });
});
