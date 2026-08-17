import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnnotationDetail,
  WorkDetail as WorkDetailType,
  WorkSummary,
} from "#/api/academic";
import { AcademicLibrary } from "#/components/academic/AcademicLibrary";
import { ImportDialog } from "#/components/academic/ImportDialog";
import { WorkDetail } from "#/components/academic/WorkDetail";
import { EMPTY_FILTER_STATE, type FilterState } from "#/lib/filters/model";

const mocks = vi.hoisted(() => ({
  createAnnotation: vi.fn(),
  createWork: vi.fn(),
  importBibtex: vi.fn(),
  importDoi: vi.fn(),
  importIsbn: vi.fn(),
  importZotero: vi.fn(),
  openPage: vi.fn(),
  updateWork: vi.fn(),
  worksFilters: vi.fn(),
  worksState: {
    data: undefined as
      | { items: WorkSummary[]; total: number; limit?: number; offset: number }
      | undefined,
    isPending: false,
    error: null as unknown,
  },
}));

const work: WorkDetailType = {
  id: "work-1",
  path: "papers/attention-is-all-you-need.md",
  title: "Attention Is All You Need",
  work_type: "paper",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  venue: "NeurIPS",
  publisher: null,
  status: "reading",
  rating: 4,
  external_ids: { doi: "10.48550/arXiv.1706.03762" },
  urls: { landing: "https://example.test/attention" },
  assets: [],
  cite_key: "vaswani2017attention",
  tags: ["transformers"],
  body: "Foundational transformer paper.",
};

const annotation: AnnotationDetail = {
  id: "annotation-1",
  path: "annotations/highlight-1.md",
  work_id: work.id,
  work_path: work.path,
  annotation_type: "highlight",
  source_asset: "paper.pdf",
  source_location: { page: 3, quote: "Attention is all you need." },
  tags: ["architecture"],
  body: "The key claim.",
};

const secondWork: WorkSummary = {
  id: "work-2",
  path: "books/computing-machinery.md",
  title: "Computing Machinery and Intelligence",
  work_type: "paper",
  authors: ["Alan Turing"],
  year: 1950,
  status: "done",
  cite_key: "turing1950computing",
  tags: ["ai"],
};

vi.mock("#/api/academic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/api/academic")>();
  return {
    ...actual,
    useAnnotations: () => ({
      data: [annotation],
      isPending: false,
      error: null,
    }),
    useCreateAnnotation: () => ({
      mutateAsync: mocks.createAnnotation,
      isPending: false,
    }),
    useCreateWork: () => ({ mutateAsync: mocks.createWork, isPending: false }),
    useImportBibtex: () => ({
      mutateAsync: mocks.importBibtex,
      isPending: false,
    }),
    useImportDoi: () => ({ mutateAsync: mocks.importDoi, isPending: false }),
    useImportIsbn: () => ({ mutateAsync: mocks.importIsbn, isPending: false }),
    useImportZotero: () => ({
      mutateAsync: mocks.importZotero,
      isPending: false,
    }),
    useUpdateWork: () => ({ mutateAsync: mocks.updateWork, isPending: false }),
    useWork: (id: string) => ({
      data: id === work.id ? work : undefined,
      isPending: false,
      error: null,
    }),
    useWorks: (filters: unknown) => {
      mocks.worksFilters(filters);
      return mocks.worksState;
    },
  };
});

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => mocks.openPage,
}));

async function chooseOption(
  user: UserEvent,
  name: string,
  option: string,
  dialog?: HTMLElement,
) {
  const queries = dialog ? within(dialog) : screen;
  await user.click(queries.getByRole("button", { name: new RegExp(name) }));
  await user.click(screen.getByRole("option", { name: option }));
}

/**
 * Local stateful harness standing in for the /academic route: AcademicLibrary
 * is a controlled component (filterState/onFilterChange are route-owned
 * props), so filter-interaction tests need a real state round-trip the same
 * way the route's useMemo/navigate wiring provides it in production.
 */
function ControlledAcademicLibrary({
  initial = EMPTY_FILTER_STATE,
}: {
  initial?: FilterState;
}) {
  const [filterState, setFilterState] = useState<FilterState>(initial);
  return (
    <AcademicLibrary
      filterState={filterState}
      onFilterChange={setFilterState}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.worksState.data = {
    items: [
      {
        id: work.id,
        path: work.path,
        title: work.title,
        work_type: work.work_type,
        authors: work.authors,
        year: work.year,
        status: work.status,
        cite_key: work.cite_key,
        tags: work.tags,
      },
      secondWork,
    ],
    total: 2,
    limit: 200,
    offset: 0,
  };
  mocks.worksState.isPending = false;
  mocks.worksState.error = null;
  mocks.createWork.mockResolvedValue(work);
  mocks.updateWork.mockResolvedValue({ ...work, title: "Attention Revisited" });
  mocks.createAnnotation.mockResolvedValue(annotation);
  mocks.importBibtex.mockResolvedValue({
    results: [
      {
        cite_key: "vaswani2017attention",
        status: "created",
        page_path: work.path,
      },
    ],
  });
  mocks.importDoi.mockResolvedValue({
    cite_key: "vaswani2017attention",
    status: "created",
    page_path: work.path,
  });
  mocks.importIsbn.mockResolvedValue({
    cite_key: "turing1950computing",
    status: "created",
    page_path: secondWork.path,
  });
  mocks.importZotero.mockResolvedValue({
    results: [{ cite_key: "item1", status: "skipped", page_path: work.path }],
  });
});

describe("AcademicLibrary", () => {
  it("lists and searches works locally, then opens the selected detail", async () => {
    const user = userEvent.setup();
    render(<ControlledAcademicLibrary />);

    expect(
      screen.getByRole("heading", { name: "Academic Library" }),
    ).toBeVisible();
    expect(screen.getByText("2 works")).toBeVisible();
    const search = screen.getByTestId("filter-bar-input");
    await user.type(search, "turing");
    expect(screen.getByText(secondWork.title ?? "")).toBeVisible();
    expect(screen.queryByText(work.title)).not.toBeInTheDocument();

    await user.clear(search);
    await user.click(
      screen.getByRole("button", { name: `Open ${work.title}` }),
    );
    expect(
      screen.getByRole("heading", { level: 2, name: work.title }),
    ).toBeVisible();
    expect(screen.getByText("vaswani2017attention")).toBeVisible();
  });

  it("creates a work from validated metadata", async () => {
    const user = userEvent.setup();
    render(<AcademicLibrary />);
    await user.click(screen.getByRole("button", { name: "Add work" }));
    const dialog = screen.getByRole("dialog", { name: "Add academic work" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Title" }),
      work.title,
    );
    await chooseOption(user, "Work type", "Book", dialog);
    await chooseOption(user, "Reading status", "Reading", dialog);
    await user.type(
      within(dialog).getByRole("textbox", { name: "Authors" }),
      "Ashish Vaswani, Noam Shazeer",
    );
    await user.type(
      within(dialog).getByRole("spinbutton", { name: "Year" }),
      "2017",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create work" }),
    );

    expect(mocks.createWork).toHaveBeenCalledWith({
      body: expect.objectContaining({
        title: work.title,
        work_type: "book",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
        status: "reading",
      }),
    });
  });

  it("loads additional pages instead of capping the library", async () => {
    const user = userEvent.setup();
    if (mocks.worksState.data) mocks.worksState.data.total = 250;
    render(<AcademicLibrary />);

    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
    await user.click(screen.getByRole("button", { name: "Load more works" }));
    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 250 }),
    );
  });
});

describe("AcademicLibrary — shared FilterBar composition", () => {
  it("adding a status facet issues the works request with status=<value>", async () => {
    const user = userEvent.setup();
    render(<ControlledAcademicLibrary />);

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-status"));
    await user.click(screen.getByTestId("filter-bar-option-status-reading"));

    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "reading" }),
    );
  });

  it("narrows the rendered list client-side without changing the request when typing text", async () => {
    const user = userEvent.setup();
    render(<ControlledAcademicLibrary />);
    const requestBefore = mocks.worksFilters.mock.calls.at(-1)?.[0];

    await user.type(screen.getByTestId("filter-bar-input"), "turing");

    expect(screen.getByText(secondWork.title ?? "")).toBeVisible();
    expect(screen.queryByText(work.title)).not.toBeInTheDocument();
    expect(mocks.worksFilters.mock.calls.at(-1)?.[0]).toEqual(requestBefore);
  });

  it("removing a facet chip restores the unfiltered works request", async () => {
    const user = userEvent.setup();
    render(<ControlledAcademicLibrary />);

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-status"));
    await user.click(screen.getByTestId("filter-bar-option-status-reading"));
    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "reading" }),
    );

    await user.click(screen.getByTestId("filter-bar-chip-status-reading"));

    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });

  it("resets the load-more limit to PAGE_SIZE when a facet changes", async () => {
    const user = userEvent.setup();
    if (mocks.worksState.data) mocks.worksState.data.total = 250;
    render(<ControlledAcademicLibrary />);

    await user.click(screen.getByRole("button", { name: "Load more works" }));
    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 250 }),
    );

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-status"));
    await user.click(screen.getByTestId("filter-bar-option-status-reading"));

    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 200, status: "reading" }),
    );
  });

  it("resets the load-more limit to PAGE_SIZE when a facet is removed", async () => {
    const user = userEvent.setup();
    if (mocks.worksState.data) mocks.worksState.data.total = 250;
    render(<ControlledAcademicLibrary />);

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-status"));
    await user.click(screen.getByTestId("filter-bar-option-status-reading"));
    await user.click(screen.getByRole("button", { name: "Load more works" }));
    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 250, status: "reading" }),
    );

    await user.click(screen.getByTestId("filter-bar-chip-status-reading"));

    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 200, status: undefined }),
    );
  });

  it("renders a raw-value chip for an unparseable year and omits it from the works request", () => {
    render(
      <ControlledAcademicLibrary
        initial={{ text: "", facets: { year: ["abc"] } }}
      />,
    );

    expect(screen.getByTestId("filter-bar-chip-year-abc")).toBeVisible();
    expect(mocks.worksFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ year: undefined }),
    );
  });
});

describe("WorkDetail", () => {
  it("updates work metadata and hands the page body to the standard editor", async () => {
    const user = userEvent.setup();
    render(<WorkDetail workId={work.id} />);

    await user.click(screen.getByRole("button", { name: "Edit metadata" }));
    const dialog = screen.getByRole("dialog", { name: "Edit academic work" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Attention Revisited");
    await chooseOption(user, "Reading status", "Done", dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Save metadata" }),
    );

    expect(mocks.updateWork).toHaveBeenCalledWith({
      params: { path: { uuid: work.id } },
      body: expect.objectContaining({
        title: "Attention Revisited",
        status: "done",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Open work page" }));
    expect(mocks.openPage).toHaveBeenCalledWith("page", work.path, work.title);
  });

  it("clears optional work metadata with explicit null values", async () => {
    const user = userEvent.setup();
    render(<WorkDetail workId={work.id} />);

    await user.click(screen.getByRole("button", { name: "Edit metadata" }));
    const dialog = screen.getByRole("dialog", { name: "Edit academic work" });
    await user.clear(within(dialog).getByRole("spinbutton", { name: "Year" }));
    await user.clear(
      within(dialog).getByRole("spinbutton", { name: "Rating" }),
    );
    await user.clear(within(dialog).getByRole("textbox", { name: "Venue" }));
    await user.clear(
      within(dialog).getByRole("textbox", { name: "Citation key" }),
    );
    await chooseOption(user, "Reading status", "Unspecified", dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Save metadata" }),
    );

    expect(mocks.updateWork).toHaveBeenCalledWith({
      params: { path: { uuid: work.id } },
      body: expect.objectContaining({
        year: null,
        status: null,
        rating: null,
        venue: null,
        cite_key: null,
      }),
    });
  });

  it("creates annotations with source locations and opens existing annotation pages", async () => {
    const user = userEvent.setup();
    render(<WorkDetail workId={work.id} />);
    expect(screen.getByText("The key claim.")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Open annotation The key claim." }),
    );
    expect(mocks.openPage).toHaveBeenCalledWith(
      "page",
      annotation.path,
      "The key claim.",
    );

    await user.click(screen.getByRole("button", { name: "Add annotation" }));
    const dialog = screen.getByRole("dialog", { name: "Add annotation" });
    await chooseOption(user, "Annotation type", "Note", dialog);
    await user.type(
      within(dialog).getByRole("textbox", { name: "Annotation body" }),
      "Compare the residual stream.",
    );
    await user.type(
      within(dialog).getByRole("spinbutton", { name: "Source page" }),
      "7",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create annotation" }),
    );

    expect(mocks.createAnnotation).toHaveBeenCalledWith({
      body: {
        work_id: work.id,
        annotation_type: "note",
        body: "Compare the residual stream.",
        tags: [],
        source_location: { page: 7 },
      },
    });
  });
});

describe("ImportDialog", () => {
  it.each([
    {
      mode: "bibtex",
      label: "BibTeX",
      input: "@article{test, title={A Test}}",
      mutation: mocks.importBibtex,
      expected: {
        body: "@article{test, title={A Test}}",
        headers: { "Content-Type": "text/plain" },
        bodySerializer: expect.any(Function),
      },
    },
    {
      mode: "doi",
      label: "DOI",
      input: "10.1000/test",
      mutation: mocks.importDoi,
      expected: { body: { doi: "10.1000/test" } },
    },
    {
      mode: "isbn",
      label: "ISBN",
      input: "978-0-262-03384-8",
      mutation: mocks.importIsbn,
      expected: { body: { isbn: "978-0-262-03384-8" } },
    },
  ])(
    "submits $label imports and reports per-item results",
    async ({ mode, label, input, mutation, expected }) => {
      const user = userEvent.setup();
      render(<ImportDialog isOpen onClose={vi.fn()} />);
      const dialog = screen.getByRole("dialog", {
        name: "Import academic works",
      });
      await chooseOption(user, "Import source", label, dialog);
      fireEvent.change(screen.getByRole("textbox", { name: label }), {
        target: { value: input },
      });
      await user.click(screen.getByRole("button", { name: `Import ${label}` }));

      expect(mutation).toHaveBeenCalledWith(expected);
      if (mode === "bibtex") {
        const request = mutation.mock.calls[0]?.[0] as {
          body: string;
          bodySerializer: (body: string) => string;
        };
        expect(request.bodySerializer(request.body)).toBe(input);
      }
      expect(await screen.findByText("created")).toBeVisible();
    },
  );

  it("supports safe Zotero dry runs and explicit conflict policy", async () => {
    const user = userEvent.setup();
    render(<ImportDialog isOpen onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", {
      name: "Import academic works",
    });
    await chooseOption(user, "Import source", "Zotero", dialog);
    await user.type(
      screen.getByRole("textbox", { name: "Zotero database path" }),
      "/Users/example/Zotero/zotero.sqlite",
    );
    await chooseOption(
      user,
      "Conflict policy",
      "Report conflicts only",
      dialog,
    );
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Dry run — inspect results without writing pages",
      }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Use and update the Zotero import checkpoint",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Import Zotero" }),
    );

    expect(mocks.importZotero).toHaveBeenCalledWith({
      body: {
        database_path: "/Users/example/Zotero/zotero.sqlite",
        conflict_policy: "manual",
        dry_run: false,
        auto_checkpoint: false,
      },
    });
    expect(await screen.findByText("skipped")).toBeVisible();
  });

  it("shows Zotero field-level conflict details", async () => {
    const user = userEvent.setup();
    mocks.importZotero.mockResolvedValueOnce({
      results: [
        {
          cite_key: "item1",
          status: "conflict",
          conflict_detail: {
            fields: [
              {
                field: "title",
                local_value: "Local title",
                source_value: "Zotero title",
              },
            ],
          },
        },
      ],
    });
    render(<ImportDialog isOpen onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", {
      name: "Import academic works",
    });
    await chooseOption(user, "Import source", "Zotero", dialog);
    await user.click(
      screen.getByRole("button", { name: "Preview Zotero import" }),
    );

    expect(await screen.findByText("title")).toBeVisible();
    expect(screen.getByText("Local title")).toBeVisible();
    expect(screen.getByText("Zotero title")).toBeVisible();
  });

  it("reports a successful import with no results", async () => {
    const user = userEvent.setup();
    mocks.importZotero.mockResolvedValueOnce({ results: [] });
    render(<ImportDialog isOpen onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", {
      name: "Import academic works",
    });
    await chooseOption(user, "Import source", "Zotero", dialog);
    await user.click(
      screen.getByRole("button", { name: "Preview Zotero import" }),
    );

    expect(await screen.findByText("No items to import.")).toBeVisible();
  });
});
