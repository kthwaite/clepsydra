import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "revision-1",
  name: "Reading Log",
  properties: {
    author: { type: "text" },
    rating: { type: "number" },
    status: { type: "select", options: ["queued", "reading"] },
  },
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

const flat: QueryOutput = { shape: "flat", rows: [row], total: 1 };

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
      sortOverride={{}}
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

describe("BaseTableView", () => {
  it("renders every view name in the switcher and switches on click", async () => {
    const user = userEvent.setup();
    const props = renderView({});
    expect(screen.getByRole("button", { name: "Continues" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Shelf" }));
    expect(props.onViewChange).toHaveBeenCalledWith("Shelf");
  });

  it("matches active view names using ASCII-case-insensitive equivalence", () => {
    renderView({ activeView: "cONTINUES" });

    expect(screen.getByRole("button", { name: "Continues" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("columnheader", { name: "author" }),
    ).toBeInTheDocument();
  });

  it("links to the definition workspace from a saved base", () => {
    renderView({});
    const configure = screen.getByRole("link", {
      name: "Configure Reading Log",
    });

    expect(configure).toHaveAttribute("href", "/bases/reading/edit");
  });

  it("opens exactly one draft and explains disabled capability", async () => {
    const user = userEvent.setup();
    const view = renderView({});
    view.onAddMember.mockImplementation(() =>
      view.rerender({ memberDraftOpen: true }),
    );

    await user.click(screen.getByRole("button", { name: "Add member" }));

    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveFocus();
    expect(screen.getAllByRole("button", { name: "Add member" })).toHaveLength(
      1,
    );
    expect(
      screen.queryByRole("button", { name: "The Book of the New Sun" }),
    ).not.toBeInTheDocument();

    view.rerender({
      memberDraftOpen: false,
      memberCapability: {
        view: "Continues",
        enabled: false,
        fields: [],
        blockers: [
          {
            scope: "membership",
            field: "word_count",
            filter_path: "filter",
            message: "word_count > 0 requires body content",
          },
        ],
      },
    });
    const add = screen.getByRole("button", { name: "Add member" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      "word_count > 0 requires body content",
    );
  });

  it("describes an unavailable capability when the server provides no blocker", () => {
    renderView({
      memberCapability: {
        view: "Continues",
        enabled: false,
        fields: [],
        blockers: [],
      },
    });

    const add = screen.getByRole("button", { name: "Add member" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      "Member creation is unavailable for this view.",
    );
  });

  it("focuses the created title when it appears in authoritative output", async () => {
    const onCreatedRowFocused = vi.fn();
    renderView({ focusCreatedId: row.id, onCreatedRowFocused });

    const createdTitle = screen.getByRole("button", {
      name: "The Book of the New Sun",
    });
    await waitFor(() => expect(createdTitle).toHaveFocus());
    expect(onCreatedRowFocused).toHaveBeenCalledTimes(1);
  });

  it("restores created-title focus after the React Aria row reclaims it", async () => {
    const onCreatedRowFocused = vi.fn();
    renderView({ focusCreatedId: row.id, onCreatedRowFocused });
    const createdTitle = screen.getByRole("button", {
      name: "The Book of the New Sun",
    });
    const tableRow = createdTitle.closest("tr");
    expect(tableRow).not.toBeNull();

    tableRow!.focus();
    expect(tableRow).toHaveFocus();
    expect(onCreatedRowFocused).not.toHaveBeenCalled();

    await waitFor(() => expect(createdTitle).toHaveFocus());
    expect(onCreatedRowFocused).toHaveBeenCalledTimes(1);
  });

  it("renders group header rows with aggregate chips", () => {
    const grouped: QueryOutput = {
      shape: "grouped",
      groups: [
        { key: "reading", total: 2, aggregates: [2, 4.75], rows: [row] },
        { key: null, total: 1, aggregates: [1, null], rows: [] },
      ],
    };
    renderView({ activeView: "Shelf", output: grouped });
    expect(screen.getByText("reading")).toBeTruthy();
    expect(screen.getByText("2 rows")).toBeTruthy();
    expect(screen.getByText(/count\s*2/)).toBeTruthy();
    expect(screen.getByText(/avg\(rating\)\s*4.75/)).toBeTruthy();
    // The NULL bucket renders as the labelled empty group.
    expect(screen.getByText("(empty)")).toBeTruthy();
  });

  it("title cell navigates to the page", async () => {
    const user = userEvent.setup();
    const props = renderView({});
    await user.click(
      screen.getByRole("button", { name: "The Book of the New Sun" }),
    );
    expect(props.onOpenPage).toHaveBeenCalledWith("book.md");
  });

  it("system and undeclared columns render read-only", async () => {
    const user = userEvent.setup();
    const props = renderView({
      definition: {
        ...definition,
        views: [
          {
            name: "Continues",
            layout: "table",
            columns: ["title", "kind", "id", "mystery"],
          },
        ],
      },
      output: {
        shape: "flat",
        total: 1,
        rows: [
          {
            ...row,
            columns: { kind: "BOOK", id: "01", mystery: "undeclared" },
          },
        ],
      },
    });
    // kind/id (system) and mystery (undeclared) are plain text, not editors.
    for (const text of ["BOOK", "01", "undeclared"]) {
      const cell = screen.getByText(text);
      expect(cell.tagName).toBe("SPAN");
      await user.click(cell);
    }
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(props.onCommitCell).not.toHaveBeenCalled();
  });

  it("sorts scalar headers but keeps multi-valued headers inert", async () => {
    const user = userEvent.setup();
    const props = renderView({
      definition: {
        ...definition,
        properties: {
          ...definition.properties,
          topics: { type: "multi_select" },
          related: { type: "relation" },
        },
        views: [
          {
            name: "Continues",
            layout: "table",
            columns: [
              "title",
              "author",
              "tags",
              "aliases",
              "topics",
              "related",
            ],
          },
        ],
      },
      output: {
        shape: "flat",
        total: 1,
        rows: [
          {
            ...row,
            columns: {
              ...row.columns,
              tags: ["fiction"],
              aliases: ["New Sun"],
              topics: ["science fantasy"],
              related: ["02"],
            },
          },
        ],
      },
    });

    for (const name of ["tags", "aliases", "topics", "related"]) {
      await user.click(screen.getByRole("columnheader", { name }));
    }
    expect(props.onSortChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("columnheader", { name: "author" }));
    expect(props.onSortChange).toHaveBeenCalledWith({
      sort: "author",
      dir: "asc",
    });
  });

  it("treats omitted property definitions as an empty read-only schema", () => {
    renderView({
      definition: {
        ...definition,
        properties: undefined,
      },
    });

    expect(screen.getByText("Gene Wolfe").tagName).toBe("SPAN");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders an error banner instead of an empty table on view failure", () => {
    renderView({ output: undefined, viewError: "query error: bad filter" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("bad filter");
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("commits an edited property cell with only the changed key", async () => {
    const user = userEvent.setup();
    const props = renderView({});
    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const input = screen.getByRole("textbox", { name: "Edit text" });
    await user.clear(input);
    await user.type(input, "G-Wolfe{Enter}");
    expect(props.onCommitCell).toHaveBeenCalledTimes(1);
    const [commitRow, key, value] = props.onCommitCell.mock.calls[0];
    expect(commitRow.id).toBe("01");
    expect(key).toBe("author");
    expect(value).toBe("G-Wolfe");
  });
  it("restores the controlled display button after Escape", async () => {
    const user = userEvent.setup();
    const props = renderView({});

    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const input = screen.getByRole("textbox", { name: "Edit text" });
    expect(input).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: "Gene Wolfe" })).toHaveFocus();
    expect(props.onCommitCell).not.toHaveBeenCalled();
  });

  it("closes a controlled editor when the active saved view changes", async () => {
    const user = userEvent.setup();
    const sharedColumnDefinition: BaseDetailResponse = {
      ...definition,
      views: [
        { name: "First", layout: "table", columns: ["title", "author"] },
        { name: "Second", layout: "table", columns: ["title", "author"] },
      ],
    };
    const props = {
      definition: sharedColumnDefinition,
      activeView: "First",
      output: flat,
      sortOverride: {},
      onViewChange: vi.fn(),
      onSortChange: vi.fn(),
      onOpenPage: vi.fn(),
      onCommitCell: vi.fn(),
    };
    const { rerender } = render(<BaseTableView {...props} />);

    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    expect(screen.getByRole("textbox", { name: "Edit text" })).toHaveFocus();

    rerender(<BaseTableView {...props} activeView="Second" />);

    expect(screen.queryByRole("textbox", { name: "Edit text" })).toBeNull();
    expect(screen.getByRole("button", { name: "Gene Wolfe" })).toBeInTheDocument();
  });


  it("commits with Tab and opens the next editable property in the row", async () => {
    const user = userEvent.setup();
    const tabDefinition: BaseDetailResponse = {
      ...definition,
      views: [
        {
          name: "Continues",
          layout: "table",
          columns: ["title", "kind", "author", "missing", "rating"],
        },
      ],
    };
    const props = renderView({ definition: tabDefinition });

    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const author = screen.getByRole("textbox", { name: "Edit text" });
    fireEvent.change(author, { target: { value: "Ursula Le Guin" } });
    fireEvent.keyDown(author, { key: "Tab" });

    expect(props.onCommitCell).toHaveBeenCalledWith(
      expect.objectContaining(row),
      "author",
      "Ursula Le Guin",
      undefined,
    );
    expect(screen.getByRole("spinbutton", { name: "Edit number" })).toHaveFocus();
  });

  it("does not reopen a Tab target after its row disappears", async () => {
    const user = userEvent.setup();
    const tabDefinition: BaseDetailResponse = {
      ...definition,
      views: [
        {
          name: "Continues",
          layout: "table",
          columns: ["title", "author", "rating"],
        },
      ],
    };
    const props = {
      definition: tabDefinition,
      activeView: "Continues",
      output: flat,
      sortOverride: {},
      onViewChange: vi.fn(),
      onSortChange: vi.fn(),
      onOpenPage: vi.fn(),
      onCommitCell: vi.fn(),
    };
    const { rerender } = render(<BaseTableView {...props} />);

    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit text" }), {
      key: "Tab",
    });
    expect(screen.getByRole("spinbutton", { name: "Edit number" })).toHaveFocus();

    rerender(
      <BaseTableView
        {...props}
        output={{ shape: "flat", rows: [], total: 0 }}
      />,
    );
    expect(screen.queryByLabelText(/^Edit /)).not.toBeInTheDocument();

    rerender(<BaseTableView {...props} />);
    expect(screen.queryByLabelText(/^Edit /)).not.toBeInTheDocument();
  });

  it("commits the last editable property with Tab without wrapping rows", async () => {
    const user = userEvent.setup();
    const secondRow = {
      ...row,
      id: "02",
      path: "second.md",
      title: "A Wizard of Earthsea",
      columns: { ...row.columns, author: "Ursula Le Guin", rating: 5 },
    };
    const tabDefinition: BaseDetailResponse = {
      ...definition,
      views: [
        {
          name: "Continues",
          layout: "table",
          columns: ["title", "author", "rating"],
        },
      ],
    };
    const props = renderView({
      definition: tabDefinition,
      output: { shape: "flat", rows: [row, secondRow], total: 2 },
    });

    await user.click(screen.getByRole("button", { name: "4.5" }));
    const rating = screen.getByRole("spinbutton", { name: "Edit number" });
    await user.clear(rating);
    await user.type(rating, "4.75");
    await user.tab();

    expect(props.onCommitCell).toHaveBeenCalledWith(
      expect.objectContaining(row),
      "rating",
      4.75,
      undefined,
    );
    expect(screen.queryByLabelText(/^Edit /)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "A Wizard of Earthsea" }),
    ).toHaveFocus();
  });

  it("keeps an invalid number open when Tab cannot accept it", async () => {
    const user = userEvent.setup();
    const props = renderView({
      definition: {
        ...definition,
        views: [
          {
            name: "Continues",
            layout: "table",
            columns: ["title", "rating", "author"],
          },
        ],
      },
    });

    await user.click(screen.getByRole("button", { name: "4.5" }));
    const rating = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Edit number",
    });
    rating.setCustomValidity("Enter a valid number");
    rating.focus();
    expect(fireEvent.keyDown(rating, { key: "Tab" })).toBe(false);

    expect(rating).toHaveFocus();
    expect(rating).toHaveValue(4.5);
    expect(props.onCommitCell).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Edit text" })).toBeNull();
  });

  it("does not use forward commit navigation for Shift+Tab", async () => {
    const user = userEvent.setup();
    const props = renderView({});

    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const author = screen.getByRole("textbox", { name: "Edit text" });
    fireEvent.keyDown(author, { key: "Tab", shiftKey: true });
    fireEvent.blur(author);

    expect(props.onCommitCell).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Edit text" })).toBeNull();
  });
  it("renders a genuinely read-only preview without fake interactive controls", () => {
    const props = renderView({ readOnly: true });

    expect(screen.queryByRole("button", { name: "Continues" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Shelf" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Configure Reading Log" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "The Book of the New Sun" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Gene Wolfe").tagName).toBe("SPAN");
    expect(
      screen.getByRole("columnheader", { name: "title" }),
    ).not.toHaveAttribute("aria-sort");
    expect(props.onViewChange).not.toHaveBeenCalled();
    expect(props.onSortChange).not.toHaveBeenCalled();
    expect(props.onOpenPage).not.toHaveBeenCalled();
  });
});
