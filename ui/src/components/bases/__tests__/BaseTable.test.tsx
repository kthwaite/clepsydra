import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type * as BasesApi from "#/api/bases";
import type { BaseDetailResponse, QueryOutput } from "#/api/bases";

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
  }) => (
    <a {...props} href={to.replace("$slug", params.slug)}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({
  createMember: vi.fn(),
  commit: vi.fn().mockResolvedValue(undefined),
  refetchBase: vi.fn(),
  refetchView: vi.fn(),
  useBase: vi.fn(),
  useBaseView: vi.fn(),
  useBaseViewWindows: vi.fn(),
  viewState: {
    data: undefined as QueryOutput | undefined,
    error: null as unknown,
    isLoading: false,
    isFetching: false,
  },
}));

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "base-rev-1",
  name: "Reading Log",
  properties: [
    {
      key: "status",
      definition: {
        type: "select",
        options: ["queued", "reading"],
      },
    },
    { key: "rating", definition: { type: "number" } },
    { key: "optional_rating", definition: { type: "number" } },
    {
      key: "optional_status",
      definition: { type: "select", options: ["one", "two"] },
    },
  ],
  views: [
    {
      name: "Continues",
      layout: "table",
      group_by: "status",
      columns: ["title", "kind", "status", "rating"],
    },
    {
      name: "Shelf",
      layout: "table",
      columns: ["title", "status"],
    },
  ],
  diagnostics: [],
  member_creation: [
    {
      view: "continues",
      enabled: true,
      fields: [
        { field: "kind", membership: true, view: false, embed: false },
        { field: "status", membership: false, view: true, embed: false },
        { field: "project", membership: false, view: false, embed: false },
        { field: "tags", membership: false, view: false, embed: false },
        { field: "aliases", membership: false, view: false, embed: false },
        {
          field: "optional_rating",
          membership: false,
          view: false,
          embed: false,
        },
        {
          field: "optional_status",
          membership: false,
          view: false,
          embed: false,
        },
      ],
      blockers: [],
    },
    {
      view: "Shelf",
      enabled: true,
      fields: [],
      blockers: [],
    },
  ],
};

vi.mock("#/api/bases", async (importOriginal) => {
  const actual = await importOriginal<typeof BasesApi>();
  return {
    ...actual,
    useBase: (slug: string) => {
      mocks.useBase(slug);
      return {
        data: definition,
        error: null,
        isLoading: false,
        refetch: mocks.refetchBase,
      };
    },
    useBaseView: (
      slug: string,
      view: string | undefined,
      overrides: BasesApi.ViewOverrides,
    ) => {
      mocks.useBaseView(slug, view, overrides);
      return { ...mocks.viewState, refetch: mocks.refetchView };
    },
    useBaseViewWindows: (config: unknown) => {
      mocks.useBaseViewWindows(config);
      return {
        data: undefined,
        error: null,
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
        total: undefined,
        loaded: 0,
        hasMore: false,
        isLoadingMore: false,
        cappedByAuthor: false,
        loadMore: vi.fn(),
      };
    },
    useCreateBaseMember: () => ({
      mutateAsync: mocks.createMember,
      isPending: false,
    }),
    usePropertyCommit: () => mocks.commit,
  };
});

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));

import { BaseTable } from "#/components/bases/BaseTable";

const existingRow = {
  id: "existing",
  path: "existing.md",
  title: "Always Coming Home",
  kind: "BOOK",
  columns: { status: "reading", rating: 8 },
};
const createdRow = {
  id: "created",
  path: "the-dispossessed.md",
  title: "The Dispossessed",
  kind: "BOOK",
  columns: { status: "reading", rating: 9 },
};

function groupedOutput(rows = [existingRow]): QueryOutput {
  return {
    shape: "grouped",
    groups: [{ key: "reading", total: rows.length, aggregates: [], rows }],
  };
}

async function fillMemberDraft(user: UserEvent) {
  const title = screen.getByRole("textbox", { name: "New member — Title" });
  await user.type(title, "The Dispossessed");
  await user.click(screen.getByRole("button", { name: "New member — Kind" }));
  await user.click(screen.getByRole("option", { name: "BOOK" }));
  await user.click(
    screen.getByRole("button", { name: "Edit New member — Status" }),
  );
  await user.click(
    screen.getByRole("button", {
      name: /—.*New member — Status/,
    }),
  );
  await user.click(screen.getByRole("option", { name: "reading" }));
  await user.click(
    screen.getByRole("button", { name: "Edit New member — Rating" }),
  );
  await user.type(
    screen.getByRole("spinbutton", { name: "New member — Rating" }),
    "9{Enter}",
  );
  return title;
}

describe("BaseTable standalone regression", () => {
  it("keeps the saved-view GET query, first-key sorting, and property commit path", async () => {
    const user = userEvent.setup();
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;
    mocks.useBase.mockReset();
    mocks.useBaseView.mockReset();
    mocks.commit.mockReset().mockResolvedValue(undefined);

    render(<BaseTable slug="reading" />);

    expect(mocks.useBase).toHaveBeenLastCalledWith("reading");
    expect(mocks.useBaseView).toHaveBeenLastCalledWith(
      "reading",
      "Continues",
      {},
    );

    await user.click(screen.getByRole("columnheader", { name: "rating" }));
    await waitFor(() =>
      expect(mocks.useBaseView).toHaveBeenLastCalledWith(
        "reading",
        "Continues",
        { sort: "rating", dir: "asc" },
      ),
    );

    await user.click(screen.getByRole("button", { name: "8" }));
    const rating = screen.getByRole("spinbutton", { name: "Edit number" });
    await user.clear(rating);
    await user.type(rating, "10{Enter}");
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "existing" }),
      "rating",
      10,
      undefined,
    );

    await user.click(screen.getByRole("button", { name: "Shelf" }));
    await waitFor(() =>
      expect(mocks.useBaseView).toHaveBeenLastCalledWith(
        "reading",
        "Shelf",
        {},
      ),
    );
  });
});

describe("BaseTable member creation", () => {
  it("opens the same draft from a final row beneath the listing", async () => {
    const user = userEvent.setup();
    render(<BaseTable slug="reading" />);

    const finalRow = await screen.findByRole("button", {
      name: "Add member to Reading Log",
    });
    await user.click(finalRow);

    expect(
      screen.getByRole("group", { name: "New base member" }),
    ).toBeInTheDocument();
    // The draft is open, so the entry points step aside until it resolves.
    expect(
      screen.queryByRole("button", { name: "Add member to Reading Log" }),
    ).toBeNull();
  });

  it("preserves a rejected draft, clears stale diagnostics on edit, then focuses the authoritative grouped row", async () => {
    const user = userEvent.setup();
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;
    mocks.createMember.mockReset();
    mocks.refetchView.mockReset();

    mocks.createMember
      .mockRejectedValueOnce({
        status: 422,
        error: "Candidate rejected",
        detail: {
          diagnostics: [
            {
              scope: "view",
              field: "rating",
              filter_path: "filter",
              message: "rating is not eligible",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        id: "created",
        path: "the-dispossessed.md",
        title: "The Dispossessed",
        revision: "page-rev-1",
      });
    mocks.refetchView.mockImplementation(async () => {
      mocks.viewState.data = groupedOutput([createdRow, existingRow]);
      return { data: mocks.viewState.data };
    });

    render(<BaseTable slug="reading" />);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    const title = await fillMemberDraft(user);
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    expect(mocks.createMember).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        base_revision: "base-rev-1",
        view: "Continues",
        title: "The Dispossessed",
        fields: {
          kind: "BOOK",
          status: "reading",
          rating: 9,
          tags: [],
          aliases: [],
        },
      },
    });
    expect(title).toHaveValue("The Dispossessed");
    expect(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    ).toHaveTextContent("9");
    expect(screen.getByRole("alert")).toHaveTextContent("Candidate rejected");

    await user.type(title, " ");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.keyboard("{Backspace}");
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    expect(mocks.createMember).toHaveBeenLastCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        base_revision: "base-rev-1",
        view: "Continues",
        title: "The Dispossessed",
        fields: {
          kind: "BOOK",
          status: "reading",
          rating: 9,
          tags: [],
          aliases: [],
        },
      },
    });
    expect(mocks.refetchView).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("textbox", { name: "New member — Title" }),
    ).not.toBeInTheDocument();

    const createdTitle = screen.getByRole("button", {
      name: "The Dispossessed",
    });
    expect(createdTitle.closest("section")).toHaveTextContent("reading");
    expect(createdTitle).toHaveFocus();
  });

  it("keeps the refreshed server placement authoritative when the created row is absent", async () => {
    const user = userEvent.setup();
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;
    mocks.createMember.mockReset();
    mocks.refetchView.mockReset();
    mocks.createMember.mockResolvedValue({
      id: "created",
      path: "the-dispossessed.md",
      title: "The Dispossessed",
      revision: "page-rev-1",
    });
    mocks.refetchView.mockResolvedValue({ data: mocks.viewState.data });

    render(<BaseTable slug="reading" />);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await fillMemberDraft(user);
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    expect(
      screen.queryByRole("button", { name: "The Dispossessed" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The member was created, but it is not included in the current view.",
    );
  });

  it("cancels the controlled draft and starts the next draft empty", async () => {
    const user = userEvent.setup();
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;

    render(<BaseTable slug="reading" />);
    const add = screen.getByRole("button", { name: "Add member" });
    await user.click(add);
    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "Discard me",
    );
    await user.click(screen.getByRole("button", { name: "Cancel new member" }));

    expect(
      screen.queryByRole("textbox", { name: "New member — Title" }),
    ).not.toBeInTheDocument();
    expect(add).toBeEnabled();

    await user.click(add);
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("");
  });

  it("keeps Add disabled through refresh and resolves focus when the saved view omits title", async () => {
    const user = userEvent.setup();
    const savedView = definition.views![0];
    const originalColumns = savedView.columns;
    savedView.columns = ["kind", "status", "rating"];
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;
    mocks.createMember.mockReset();
    mocks.refetchView.mockReset();
    mocks.createMember.mockResolvedValue({
      id: "created",
      path: "the-dispossessed.md",
      title: "The Dispossessed",
      revision: "page-rev-1",
    });
    let resolveRefresh: (() => void) | undefined;
    mocks.refetchView.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => {
            mocks.viewState.data = groupedOutput([createdRow, existingRow]);
            resolve({ data: mocks.viewState.data });
          };
        }),
    );

    render(<BaseTable slug="reading" />);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await fillMemberDraft(user);
    await user.click(screen.getByRole("button", { name: "Save new member" }));
    await waitFor(() => expect(mocks.refetchView).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Add member" })).toBeDisabled();

    resolveRefresh?.();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The member was created, but this view does not display its title.",
    );
    expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled();
    savedView.columns = originalColumns;
  });

  it("refetches a revision conflict and resubmits the preserved draft with the refreshed revision", async () => {
    const user = userEvent.setup();
    definition.revision = "base-rev-1";
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;
    mocks.createMember.mockReset();
    mocks.refetchBase.mockReset();
    mocks.refetchView.mockReset();
    mocks.createMember
      .mockRejectedValueOnce({
        status: 409,
        error: "Base revision conflict",
        detail: { code: "base_revision_conflict" },
      })
      .mockResolvedValueOnce({
        id: "created",
        path: "the-dispossessed.md",
        title: "The Dispossessed",
        revision: "page-rev-1",
      });
    mocks.refetchBase.mockImplementation(async () => {
      definition.revision = "base-rev-2";
      return { data: definition };
    });
    mocks.refetchView.mockImplementation(async () => {
      mocks.viewState.data = groupedOutput([createdRow, existingRow]);
      return { data: mocks.viewState.data };
    });

    render(<BaseTable slug="reading" />);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    const title = await fillMemberDraft(user);
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    await waitFor(() => expect(mocks.refetchBase).toHaveBeenCalledTimes(1));
    expect(title).toHaveValue("The Dispossessed");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Base revision conflict",
    );

    await user.click(screen.getByRole("button", { name: "Save new member" }));
    await waitFor(() => expect(mocks.createMember).toHaveBeenCalledTimes(2));
    expect(mocks.createMember.mock.calls[1][0].body.base_revision).toBe(
      "base-rev-2",
    );
  });

  it("keeps the original operation busy and settles without stale focus after a view switch", async () => {
    const user = userEvent.setup();
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;
    mocks.createMember.mockReset();
    mocks.refetchView.mockReset();
    mocks.createMember.mockResolvedValue({
      id: "created",
      path: "the-dispossessed.md",
      title: "The Dispossessed",
      revision: "page-rev-1",
    });
    let resolveRefresh: (() => void) | undefined;
    mocks.refetchView.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => {
            mocks.viewState.data = groupedOutput([createdRow, existingRow]);
            resolve({ data: mocks.viewState.data });
          };
        }),
    );

    render(<BaseTable slug="reading" />);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await fillMemberDraft(user);
    await user.click(screen.getByRole("button", { name: "Save new member" }));
    await waitFor(() => expect(mocks.refetchView).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Shelf" }));
    const add = screen.getByRole("button", { name: "Add member" });
    expect(add).toBeDisabled();
    await user.click(add);
    expect(
      screen.queryByRole("textbox", { name: "New member — Title" }),
    ).not.toBeInTheDocument();

    resolveRefresh?.();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The member was created, but focus was skipped because the active view changed.",
    );
    const oldCreatedTitle = screen.getByRole("button", {
      name: "The Dispossessed",
    });
    expect(oldCreatedTitle).not.toHaveFocus();
    const readyAdd = screen.getByRole("button", { name: "Add member" });
    expect(readyAdd).toBeEnabled();

    await user.click(readyAdd);
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveFocus();
    expect(oldCreatedTitle).not.toHaveFocus();
  });

  it("omits cleared project and nullable property values from the endpoint payload", async () => {
    const user = userEvent.setup();
    mocks.viewState.data = groupedOutput();
    mocks.viewState.error = null;
    mocks.viewState.isLoading = false;
    mocks.viewState.isFetching = false;
    mocks.createMember.mockReset();
    mocks.createMember.mockRejectedValue({
      status: 422,
      error: "Candidate rejected",
    });

    render(<BaseTable slug="reading" />);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await fillMemberDraft(user);

    const project = screen.getByRole("combobox", {
      name: "New member — Project",
    });
    await user.type(project, "clepsydra{Enter}");
    await user.click(
      screen.getByRole("button", { name: "Clear New member — Project" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Edit New member — Optional Rating",
      }),
    );
    await user.type(
      screen.getByRole("spinbutton", {
        name: "New member — Optional Rating",
      }),
      "7{Enter}",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Optional Rating" }),
    );
    const rating = screen.getByRole("spinbutton", {
      name: "New member — Optional Rating",
    });
    await user.clear(rating);
    await user.keyboard("{Enter}");

    await user.click(
      screen.getByRole("button", {
        name: "Edit New member — Optional Status",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /—.*New member — Optional Status/,
      }),
    );
    await user.click(screen.getByRole("option", { name: "one" }));
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Optional Status" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /one.*New member — Optional Status/,
      }),
    );
    await user.click(screen.getByRole("option", { name: "—" }));

    await user.click(screen.getByRole("button", { name: "Save new member" }));
    await waitFor(() => expect(mocks.createMember).toHaveBeenCalledOnce());
    const fields = mocks.createMember.mock.calls[0][0].body.fields;
    expect(fields).not.toHaveProperty("project");
    expect(fields).not.toHaveProperty("optional_rating");
    expect(fields).not.toHaveProperty("optional_status");
    expect(Object.values(fields)).not.toContain(null);
    expect(fields.tags).toEqual([]);
    expect(fields.aliases).toEqual([]);
  });
});
