import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseDetailResponse, BaseMutationResponse } from "#/api/bases";
import { BaseDefinitionWorkspace } from "#/components/bases/BaseDefinitionWorkspace";

const { previewMock, updateMock, useBlockerMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  updateMock: vi.fn(),
  useBlockerMock: vi.fn(),
}));

let baseState: {
  data?: BaseDetailResponse;
  isPending: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
};
let blockerState: {
  status: "idle" | "blocked";
  proceed?: () => void;
  reset?: () => void;
};

vi.mock("@tanstack/react-router", () => ({
  useBlocker: (options: unknown) => {
    useBlockerMock(options);
    return blockerState;
  },
}));

vi.mock("#/api/bases", () => ({
  useBase: () => baseState,
  usePreviewBase: () => ({ mutateAsync: previewMock }),
  useUpdateBase: () => ({ mutateAsync: updateMock, isPending: false }),
}));

const detail: BaseDetailResponse = {
  slug: "reading-log",
  name: "Reading Log",
  description: "Books in progress",
  filter: undefined,
  properties: {},
  views: [
    {
      name: "All",
      layout: "table",
      sort: [],
      aggregates: [],
      columns: ["title"],
    },
  ],
  diagnostics: [],
  revision: "revision-1",
};

function mutationResponse(
  overrides: Partial<BaseMutationResponse> = {},
): BaseMutationResponse {
  return { ...detail, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function renderWorkspace() {
  return render(<BaseDefinitionWorkspace slug="reading-log" />);
}

async function renameBase(name: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText("Name");
  await user.clear(input);
  await user.type(input, name);
  return user;
}

beforeEach(() => {
  updateMock.mockReset();
  previewMock.mockReset();
  previewMock.mockResolvedValue({
    diagnostics: [],
    output: { shape: "flat", rows: [], total: 0 },
  });
  useBlockerMock.mockReset();
  blockerState = { status: "idle" };
  baseState = {
    data: detail,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  };
});

describe("BaseDefinitionWorkspace", () => {
  it("renders a named loading status before hydration", () => {
    baseState.data = undefined;
    baseState.isPending = true;
    renderWorkspace();
    expect(screen.getByRole("status")).toHaveTextContent(
      /loading base definition/i,
    );
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("hydrates the server definition and exposes immutable identity", () => {
    renderWorkspace();
    expect(screen.getByLabelText("Name")).toHaveValue("Reading Log");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Books in progress",
    );
    expect(screen.getAllByText("reading-log")).toHaveLength(2);
    expect(screen.getByText("bases/reading-log.base.toml")).toBeInTheDocument();
    expect(screen.getByText("revision-1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy base file path" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("marks edits dirty and saves with the captured original revision", async () => {
    updateMock.mockResolvedValue(
      mutationResponse({ name: "My Reading", revision: "revision-2" }),
    );
    renderWorkspace();
    const user = await renameBase("My Reading");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({ name: "My Reading" }),
      },
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("revision-2")).toBeInTheDocument();
  });

  it("saves the exact membership filter edited in the workspace", async () => {
    const filter = { field: "id", op: "eq", value: "page-1" } as const;
    updateMock.mockResolvedValue(
      mutationResponse({ filter, revision: "revision-2" }),
    );
    renderWorkspace();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "id",
    );
    await user.type(screen.getByLabelText("Value for condition 1"), "page-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({ filter }),
      },
    });
  });

  it("shows saving and keeps edits made during the request dirty", async () => {
    const pending = deferred<BaseMutationResponse>();
    updateMock.mockReturnValue(pending.promise);
    renderWorkspace();
    const user = await renameBase("Submitted name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Typed during save");
    await act(async () => {
      pending.resolve(
        mutationResponse({ name: "Submitted name", revision: "revision-2" }),
      );
      await pending.promise;
    });
    expect(screen.getByLabelText("Name")).toHaveValue("Typed during save");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("revision-2")).toBeInTheDocument();
  });

  it("discards local edits back to the last server baseline", async () => {
    renderWorkspace();
    const user = await renameBase("Temporary name");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Reading Log");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("does not overwrite a dirty draft when the query refetches", async () => {
    const view = renderWorkspace();
    await renameBase("Local draft");
    baseState.data = {
      ...detail,
      name: "External name",
      revision: "revision-2",
    };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("Local draft");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("accepts a newer query revision after ignoring the known pre-save revision", async () => {
    updateMock.mockResolvedValue(
      mutationResponse({ name: "My Reading", revision: "revision-2" }),
    );
    const view = renderWorkspace();
    const user = await renameBase("My Reading");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("revision-2")).toBeInTheDocument();

    baseState.data = detail;
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("My Reading");
    expect(screen.getByText("revision-2")).toBeInTheDocument();

    baseState.data = {
      ...detail,
      name: "Newer external name",
      revision: "revision-3",
    };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("Newer external name");
    expect(screen.getByText("revision-3")).toBeInTheDocument();
  });

  it("keeps both submitted revisions obsolete across consecutive saves", async () => {
    updateMock
      .mockResolvedValueOnce(
        mutationResponse({ name: "First save", revision: "revision-2" }),
      )
      .mockResolvedValueOnce(
        mutationResponse({ name: "Second save", revision: "revision-3" }),
      );
    const view = renderWorkspace();
    const user = await renameBase("First save");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("revision-2")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Second save");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenLastCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-2",
        definition: expect.objectContaining({ name: "Second save" }),
      },
    });
    expect(await screen.findByText("revision-3")).toBeInTheDocument();

    baseState.data = { ...detail };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue("Second save");
    expect(screen.getByText("revision-3")).toBeInTheDocument();

    baseState.data = {
      ...detail,
      name: "Genuine external update",
      revision: "revision-4",
    };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByLabelText("Name")).toHaveValue(
      "Genuine external update",
    );
    expect(screen.getByText("revision-4")).toBeInTheDocument();
  });

  it("preserves a dirty draft on revision conflict until deliberate reload", async () => {
    updateMock.mockRejectedValue({
      status: 409,
      error: "base definition changed since expected_revision",
      detail: { revision: "server-new" },
    });
    baseState.refetch.mockResolvedValue({
      data: { ...detail, name: "Server name", revision: "server-new" },
    });
    renderWorkspace();
    const user = await renameBase("My Reading");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /changed outside clepsydra/i,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("My Reading");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(baseState.refetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByRole("heading", { name: "Views" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review my draft" }));
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(baseState.refetch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Views" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload from file" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/discard your draft/i);
    await user.click(
      screen.getByRole("button", { name: "Reload and discard" }),
    );
    await waitFor(() => expect(baseState.refetch).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Name")).toHaveValue("Server name");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("keeps conflict recovery intact when reload fails with retained stale data", async () => {
    baseState.data = {
      ...detail,
      diagnostics: [
        {
          slug: "reading-log",
          severity: "warning",
          path: "description",
          message: "Original warning",
        },
      ],
    };
    updateMock.mockRejectedValue({
      status: 409,
      error: "base definition changed since expected_revision",
    });
    baseState.refetch.mockResolvedValue({
      data: baseState.data,
      isError: true,
      error: { status: 500, error: "vault unavailable" },
    });
    renderWorkspace();
    const user = await renameBase("My conflicted draft");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText("Description"), " plus local edit");

    expect(screen.getByRole("alert")).toHaveTextContent(
      /changed outside clepsydra/i,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Review my draft" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload from file" }));
    await user.click(
      screen.getByRole("button", { name: "Reload and discard" }),
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /vault unavailable/i,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("My conflicted draft");
    expect(screen.getByText("revision-1")).toBeInTheDocument();
    expect(screen.getByText(/Original warning/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep my draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /changed outside clepsydra/i,
    );
    expect(
      screen.getByRole("button", { name: "Reload from file" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Reading Log");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("guards browser and internal navigation while dirty", async () => {
    const view = renderWorkspace();
    const user = userEvent.setup();
    await renameBase("Local draft");
    const options = useBlockerMock.mock.calls.at(-1)?.[0] as {
      shouldBlockFn: () => boolean;
      enableBeforeUnload: boolean;
      withResolver: boolean;
    };
    expect(options.enableBeforeUnload).toBe(true);
    expect(options.withResolver).toBe(true);
    expect(options.shouldBlockFn()).toBe(true);
    const proceed = vi.fn();
    const reset = vi.fn();
    blockerState = { status: "blocked", proceed, reset };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    expect(screen.getByRole("dialog")).toHaveTextContent(/unsaved changes/i);
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(reset).toHaveBeenCalledTimes(1);
    blockerState = { status: "blocked", proceed, reset };
    view.rerender(<BaseDefinitionWorkspace slug="reading-log" />);
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("recovers from an unparseable existing file without fabricating a draft", () => {
    baseState.data = undefined;
    baseState.error = {
      status: 409,
      error: "invalid base file: expected a table",
    };
    renderWorkspace();
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid base file/i);
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("bases/reading-log.base.toml")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy base file path" }),
    ).toBeInTheDocument();
  });

  it("groups diagnostic controls by section and moves focus to the exact path", async () => {
    baseState.data = {
      ...detail,
      diagnostics: [
        {
          slug: "reading-log",
          severity: "error",
          path: "name",
          message: "base name must not be empty",
        },
        {
          slug: "reading-log",
          severity: "warning",
          path: "views[0].sort[0]",
          message: "sort field is unavailable",
        },
      ],
    };
    const user = userEvent.setup();
    renderWorkspace();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
    const nameDiagnostic = screen.getByRole("button", {
      name: /base name must not be empty/i,
    });
    expect(nameDiagnostic).toHaveAttribute("data-diagnostic-path", "name");
    await user.click(nameDiagnostic);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    const viewDiagnostic = screen.getByRole("button", {
      name: /sort field is unavailable/i,
    });
    expect(viewDiagnostic).toHaveAttribute(
      "data-diagnostic-path",
      "views[0].sort[0]",
    );
    await user.click(viewDiagnostic);
    expect(screen.getByRole("button", { name: "Select All" })).toHaveFocus();
  });
  it("saves the exact authored view while previewing the unsaved definition", async () => {
    updateMock.mockResolvedValue(
      mutationResponse({
        views: [
          {
            name: "Everything",
            layout: "table",
            filter: {
              all: [{ field: "kind", op: "eq", value: "book" }],
            },
            columns: ["title"],
            sort: [],
            aggregates: [],
          },
        ],
        revision: "revision-2",
      }),
    );
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    const name = screen.getByLabelText("View name");
    await user.clear(name);
    await user.type(name, "Everything");
    await user.click(
      screen.getByRole("button", { name: "Add Match all group" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Add condition to Match all" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "kind",
    );
    await user.type(screen.getByLabelText("Value for condition 1"), "book");
    await waitFor(() => expect(previewMock).toHaveBeenCalled());

    expect(previewMock).toHaveBeenLastCalledWith({
      body: {
        definition: expect.objectContaining({
          views: [
            expect.objectContaining({
              name: "Everything",
              filter: {
                all: [{ field: "kind", op: "eq", value: "book" }],
              },
            }),
          ],
        }),
        view: "Everything",
        limit: 100,
        offset: 0,
      },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: {
        expected_revision: "revision-1",
        definition: expect.objectContaining({
          views: [
            expect.objectContaining({
              name: "Everything",
              filter: {
                all: [{ field: "kind", op: "eq", value: "book" }],
              },
            }),
          ],
        }),
      },
    });
  });

  it("keeps Save available when preview networking fails", async () => {
    previewMock.mockRejectedValue(new Error("preview offline"));
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    const name = screen.getByLabelText("View name");
    await user.clear(name);
    await user.type(name, "Changed");
    await waitFor(() => expect(previewMock).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /preview offline/i,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("preserves an unsupported layout through an unrelated edit in preview and save", async () => {
    const unsupported = {
      ...detail,
      views: [
        {
          name: "Board",
          layout: "board",
          sort: [],
          aggregates: [],
          columns: ["title"],
        },
      ],
    } as unknown as BaseDetailResponse;
    baseState.data = unsupported;
    updateMock.mockResolvedValue({
      ...unsupported,
      revision: "revision-2",
    });
    renderWorkspace();
    const user = await renameBase("Renamed only");
    await user.click(screen.getByRole("button", { name: "Views" }));
    await waitFor(() => expect(previewMock).toHaveBeenCalled());

    const definition = {
      name: "Renamed only",
      description: "Books in progress",
      filter: undefined,
      properties: {},
      views: [
        {
          name: "Board",
          layout: "board",
          filter: undefined,
          sort: [],
          group_by: undefined,
          aggregates: [],
          columns: ["title"],
        },
      ],
    };
    expect(previewMock).toHaveBeenLastCalledWith({
      body: { definition, view: "Board", limit: 100, offset: 0 },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMock).toHaveBeenCalledWith({
      params: { path: { slug: "reading-log" } },
      body: { expected_revision: "revision-1", definition },
    });
  });

  it("keeps the selected logical view after rename, reorder, and fresh response IDs", async () => {
    const twoViews: BaseDetailResponse = {
      ...detail,
      views: [
        { name: "All", layout: "table", columns: ["title"] },
        { name: "Later", layout: "table", columns: ["title"] },
      ],
    };
    baseState.data = twoViews;
    updateMock.mockResolvedValue({
      ...twoViews,
      views: [
        { name: "Later saved", layout: "table", columns: ["title"] },
        { name: "All", layout: "table", columns: ["title"] },
      ],
      revision: "revision-2",
    });
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Select Later" }));
    const viewName = screen.getByLabelText("View name");
    await user.clear(viewName);
    await user.type(viewName, "Later saved");
    await user.click(
      screen.getByRole("button", { name: "Move Later saved up" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("revision-2")).toBeInTheDocument();
    expect(screen.getByLabelText("View name")).toHaveValue("Later saved");
    expect(
      screen.getByRole("button", { name: "Select Later saved" }),
    ).toHaveAttribute("aria-current", "true");
    await waitFor(() =>
      expect(previewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ view: "Later saved" }),
        }),
      ),
    );
  });

  it("keeps a view selected while an unchanged draft save is in flight", async () => {
    const twoViews: BaseDetailResponse = {
      ...detail,
      views: [
        { name: "All", layout: "table", columns: ["title"] },
        { name: "Later", layout: "table", columns: ["title"] },
      ],
    };
    const pending = deferred<BaseMutationResponse>();
    baseState.data = twoViews;
    updateMock.mockReturnValue(pending.promise);
    renderWorkspace();
    const user = await renameBase("Saved name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(screen.getByRole("button", { name: "Select Later" }));

    await act(async () => {
      pending.resolve({
        ...twoViews,
        name: "Saved name",
        revision: "revision-2",
      });
      await pending.promise;
    });

    expect(screen.getByLabelText("View name")).toHaveValue("Later");
    expect(
      screen.getByRole("button", { name: "Select Later" }),
    ).toHaveAttribute("aria-current", "true");
    await waitFor(() =>
      expect(previewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ view: "Later" }),
        }),
      ),
    );
  });
});
