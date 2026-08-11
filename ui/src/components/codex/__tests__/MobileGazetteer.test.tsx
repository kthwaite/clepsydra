import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ContentEntry, TagCount } from "#/api/types";
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

const tags: TagCount[] = [
  { tag: "research", count: 4, computed_count: 0 },
  { tag: "active", count: 2, computed_count: 0 },
];

function renderGazetteer(
  overrides: Partial<React.ComponentProps<typeof MobileGazetteer>> = {},
) {
  const props: React.ComponentProps<typeof MobileGazetteer> = {
    query: "",
    selectedTags: [],
    sort: "ts",
    projects: ["atlas", "clepsydra"],
    rows,
    tags,
    tagsLoading: false,
    tagsError: null,
    onRetryTags: vi.fn(),
    totalCount: 2,
    filteredCount: 2,
    page: 1,
    pageCount: 1,
    onQueryChange: vi.fn(),
    onSelectedTagsChange: vi.fn(),
    onKindChange: vi.fn(),
    onProjectChange: vi.fn(),
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
    expect(within(alpha).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(onOpen).toHaveBeenCalledWith("notes/alpha.md", "Alpha");
  });

  it("opens a named dismissible filter sheet and emits controlled changes", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onSelectedTagsChange = vi.fn();
    const onSortChange = vi.fn();
    renderGazetteer({ onQueryChange, onSelectedTagsChange, onSortChange });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Gazetteer filters" });
    expect(dialog).toBeVisible();

    await user.type(
      within(dialog).getByRole("searchbox", { name: "Search pages" }),
      "a",
    );
    expect(onQueryChange).toHaveBeenCalledWith("a");

    const tagPicker = within(dialog).getByRole("combobox", {
      name: "Filter by tags",
    });
    await user.type(tagPicker, "res");
    await user.click(
      within(dialog).getByRole("option", { name: "#research" }),
    );
    expect(onSelectedTagsChange).toHaveBeenCalledWith(["research"]);

    await user.click(within(dialog).getByRole("radio", { name: "Title" }));
    expect(onSortChange).toHaveBeenCalledWith("title");

    await user.click(
      within(dialog).getByRole("button", { name: "Close filters" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Gazetteer filters" }),
    ).not.toBeInTheDocument();
  });
  it("clears selected tags without rendering the complete vocabulary as buttons", async () => {
    const user = userEvent.setup();
    const onSelectedTagsChange = vi.fn();
    renderGazetteer({
      selectedTags: ["legacy-url-tag"],
      onSelectedTagsChange,
    });

    await user.click(screen.getByRole("button", { name: "Filters · 1" }));
    const dialog = screen.getByRole("dialog", { name: "Gazetteer filters" });
    expect(
      within(dialog).getByRole("combobox", { name: "Filter by tags" }),
    ).toBeVisible();
    expect(within(dialog).getByText("#legacy-url-tag")).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: "Filter by research" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Filter by active" }),
    ).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Clear tags" }));
    expect(onSelectedTagsChange).toHaveBeenCalledWith([]);
  });

  it("emits controlled Kind and Project changes from the shared vocabularies", async () => {
    const user = userEvent.setup();
    const onKindChange = vi.fn();
    const onProjectChange = vi.fn();
    renderGazetteer({
      kind: "PROJECT",
      project: "clepsydra",
      onKindChange,
      onProjectChange,
    });

    await user.click(screen.getByRole("button", { name: "Filters · 2" }));
    const dialog = screen.getByRole("dialog", { name: "Gazetteer filters" });

    await user.click(
      within(dialog).getByRole("button", { name: "Filter by kind" }),
    );
    for (const kind of KINDS) {
      expect(
        screen.getByRole("option", { name: kindLabel(kind) }),
      ).toBeVisible();
    }
    await user.click(screen.getByRole("option", { name: "NOTE" }));
    expect(onKindChange).toHaveBeenCalledWith("NOTE");

    const project = within(dialog).getByRole("combobox", {
      name: "Filter by project",
    });
    await user.click(project);
    expect(screen.getByRole("option", { name: "atlas" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "atlas" }));
    expect(onProjectChange).toHaveBeenCalledWith("atlas");
  });
});
