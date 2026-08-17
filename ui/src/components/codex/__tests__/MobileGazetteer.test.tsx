import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ContentEntry } from "#/api/types";
import type { FilterField } from "#/lib/filters/model";
import { KINDS, kindLabel } from "#/lib/kind";
import { MobileGazetteer } from "../MobileGazetteer";

const rows: ContentEntry[] = [
  {
    created_at: "2026-08-01T12:00:00Z",
    description: "First note",
    inferred: false,
    kind: "NOTE",
    links: [],
    path: "notes/alpha.md",
    project: "Atlas",
    tags: ["research", "active"],
    computed_tags: [],
    title: "Alpha",
    updated_at: "2026-08-08T12:00:00Z",
    word_count: 321,
  },
  {
    created_at: "2026-08-02T12:00:00Z",
    description: "Second note",
    inferred: false,
    kind: "NOTE",
    links: [],
    path: "notes/beta.md",
    project: null,
    tags: [],
    computed_tags: [],
    title: "Beta",
    updated_at: "2026-08-07T12:00:00Z",
    word_count: 89,
  },
];

const FILTER_FIELDS: FilterField[] = [
  {
    id: "kind",
    kind: "single",
    label: "KIND",
    options: KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
  },
  {
    id: "project",
    kind: "single",
    label: "PROJECT",
    options: [{ value: "atlas" }, { value: "clepsydra" }],
  },
  {
    id: "tags",
    kind: "multi",
    label: "TAG",
    options: [{ value: "research" }, { value: "active" }],
  },
];

function renderGazetteer(
  overrides: Partial<React.ComponentProps<typeof MobileGazetteer>> = {},
) {
  const props: React.ComponentProps<typeof MobileGazetteer> = {
    filterState: { text: "", facets: {} },
    filterFields: FILTER_FIELDS,
    sort: "ts",
    rows,
    totalCount: 2,
    filteredCount: 2,
    page: 1,
    pageCount: 1,
    onFilterChange: vi.fn(),
    onSortChange: vi.fn(),
    onPageChange: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  };

  render(<MobileGazetteer {...props} />);
  return props;
}

describe("MobileGazetteer", () => {
  it("renders page metadata as a semantic list with one explicit open action per row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderGazetteer({ onOpen });

    const list = screen.getByRole("list", { name: "Vault pages" });
    expect(list).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    const alpha = within(list).getAllByRole("listitem")[0];
    expect(alpha).toHaveTextContent("Alpha");
    expect(alpha).toHaveTextContent("notes/alpha.md");
    expect(alpha).toHaveTextContent("NOTE");
    expect(alpha).toHaveTextContent("Atlas");
    expect(alpha).toHaveTextContent("#research");
    expect(alpha).toHaveTextContent("#active");
    expect(alpha).toHaveTextContent("321 words");
    expect(alpha).toHaveTextContent("Edited");
    expect(within(alpha).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(onOpen).toHaveBeenCalledWith("notes/alpha.md", "Alpha");
  });

  it("appends a result tag through the controlled callback and makes it keyboard reachable", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    renderGazetteer({
      filterState: { text: "", facets: { tags: ["pkm"] } },
      onFilterChange,
    });

    const resultTag = screen.getByRole("button", {
      name: "Filter by tag research",
    });
    expect(resultTag).toHaveAttribute("aria-pressed", "false");

    await user.tab();
    expect(screen.getByRole("button", { name: "Filters · 1" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Open Alpha" })).toHaveFocus();
    await user.tab();
    expect(resultTag).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onFilterChange).toHaveBeenCalledOnce();
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { tags: ["pkm", "research"] },
    });
  });

  it("exposes active result tags as pressed and keeps their activation inert", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    renderGazetteer({
      filterState: { text: "", facets: { tags: ["research"] } },
      onFilterChange,
    });

    const activeTag = screen.getByRole("button", {
      name: "Filter by tag research",
    });
    expect(activeTag).toHaveAttribute("aria-pressed", "true");

    await user.click(activeTag);
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it("opens a named dismissible filter sheet and emits controlled changes", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    const onSortChange = vi.fn();
    renderGazetteer({ onFilterChange, onSortChange });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Gazetteer filters" });
    expect(dialog).toBeVisible();

    await user.type(
      within(dialog).getByRole("searchbox", { name: "Search pages" }),
      "a",
    );
    expect(onFilterChange).toHaveBeenCalledWith({ text: "a", facets: {} });

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-tags"));
    await user.click(screen.getByTestId("filter-bar-option-tags-research"));
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { tags: ["research"] },
    });
    // multi-select keeps the add-filter popover open; close it explicitly.
    await user.click(screen.getByTestId("filter-bar-add"));

    await user.click(within(dialog).getByRole("radio", { name: "Title" }));
    expect(onSortChange).toHaveBeenCalledWith("title");

    await user.click(
      within(dialog).getByRole("button", { name: "Close filters" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Gazetteer filters" }),
    ).not.toBeInTheDocument();
  });

  it("clears the active filter without rendering the complete tag vocabulary as chips", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    renderGazetteer({
      filterState: { text: "", facets: { tags: ["legacy-url-tag"] } },
      onFilterChange,
    });

    await user.click(screen.getByRole("button", { name: "Filters · 1" }));
    const dialog = screen.getByRole("dialog", { name: "Gazetteer filters" });
    expect(
      within(dialog).getByTestId("filter-bar-chip-tags-legacy-url-tag"),
    ).toBeVisible();
    expect(
      within(dialog).queryByTestId("filter-bar-chip-tags-research"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByTestId("filter-bar-chip-tags-active"),
    ).not.toBeInTheDocument();

    await user.click(within(dialog).getByTestId("filter-bar-clear"));
    expect(onFilterChange).toHaveBeenCalledWith({ text: "", facets: {} });
  });

  it("emits controlled Kind and Project changes from the shared vocabularies", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    renderGazetteer({
      filterState: {
        text: "",
        facets: { kind: ["PROJECT"], project: ["clepsydra"] },
      },
      onFilterChange,
    });

    await user.click(screen.getByRole("button", { name: "Filters · 2" }));
    expect(
      screen.getByRole("dialog", { name: "Gazetteer filters" }),
    ).toBeVisible();

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-kind"));
    for (const kind of KINDS) {
      expect(
        screen.getByTestId(`filter-bar-option-kind-${kind}`),
      ).toBeVisible();
    }
    await user.click(screen.getByTestId("filter-bar-option-kind-NOTE"));
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { kind: ["NOTE"], project: ["clepsydra"] },
    });

    // single-select closes the popover; reopen it for the project field.
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-project"));
    await user.click(screen.getByTestId("filter-bar-option-project-atlas"));
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { kind: ["PROJECT"], project: ["atlas"] },
    });
  });
});
