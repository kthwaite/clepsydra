import type {
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BasesApi from "#/api/bases";
import type {
  BaseDetailResponse,
  BaseMemberCapability,
  BaseMemberCreateRequest,
  BaseMemberCreateResponse,
} from "#/api/bases";

type UseBaseResult = UseQueryResult<BaseDetailResponse, Error>;

interface CreateBaseMemberVariables {
  params: { path: { slug: string } };
  body: BaseMemberCreateRequest;
}

type UseCreateBaseMemberResult = UseMutationResult<
  BaseMemberCreateResponse,
  unknown,
  CreateBaseMemberVariables
>;

interface BaseHookState {
  data: BaseDetailResponse | undefined;
  error: UseBaseResult["error"];
  isLoading: boolean;
  isFetching: boolean;
}

const mocks = vi.hoisted(() => ({
  createMember:
    vi.fn<UseCreateBaseMemberResult["mutateAsync"]>(),
  mutateMember: vi.fn<UseCreateBaseMemberResult["mutate"]>(),
  refetchBase: vi.fn<UseBaseResult["refetch"]>(),
  resetMutation: vi.fn<UseCreateBaseMemberResult["reset"]>(),
  useBase: vi.fn<(slug: string) => void>(),
  projects: ["clepsydra", "vessel"],
  detail: {
    data: undefined as BaseDetailResponse | undefined,
    error: null as UseBaseResult["error"],
    isLoading: false,
    isFetching: false,
  },
  mutation: { isPending: false },
}));

function useBaseResult(
  state: BaseHookState = mocks.detail,
): UseBaseResult {
  const common = {
    dataUpdatedAt: state.data === undefined ? 0 : 1,
    errorUpdatedAt: state.error === null ? 0 : 1,
    failureCount: state.error === null ? 0 : 1,
    failureReason: state.error,
    errorUpdateCount: state.error === null ? 0 : 1,
    isFetched: state.data !== undefined || state.error !== null,
    isFetchedAfterMount: state.data !== undefined || state.error !== null,
    isFetching: state.isFetching,
    isLoading: state.isLoading,
    isInitialLoading: state.isLoading,
    isPaused: false,
    isRefetching: state.isFetching && state.data !== undefined,
    isStale: false,
    isEnabled: true,
    refetch: mocks.refetchBase,
    fetchStatus: state.isFetching ? ("fetching" as const) : ("idle" as const),
  };

  if (state.data !== undefined) {
    return {
      ...common,
      data: state.data,
      error: null,
      isError: false,
      isPending: false,
      isLoading: false,
      isInitialLoading: false,
      isLoadingError: false,
      isPlaceholderData: false,
      isRefetchError: false,
      isSuccess: true,
      status: "success",
      promise: Promise.resolve(state.data),
    };
  }
  if (state.error !== null) {
    return {
      ...common,
      data: undefined,
      error: state.error,
      isError: true,
      isPending: false,
      isLoading: false,
      isInitialLoading: false,
      isLoadingError: true,
      isPlaceholderData: false,
      isRefetchError: false,
      isSuccess: false,
      status: "error",
      promise: new Promise<BaseDetailResponse>(() => {}),
    };
  }
  return {
    ...common,
    data: undefined,
    error: null,
    isError: false,
    isPending: true,
    isLoadingError: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isSuccess: false,
    status: "pending",
    promise: new Promise<BaseDetailResponse>(() => {}),
  };
}

function useCreateBaseMemberResult(): UseCreateBaseMemberResult {
  const common = {
    context: undefined,
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isError: false,
    isPaused: false,
    isSuccess: false,
    mutate: mocks.mutateMember,
    mutateAsync: mocks.createMember,
    reset: mocks.resetMutation,
  } as const;
  if (mocks.mutation.isPending) {
    return {
      ...common,
      isIdle: false,
      isPending: true,
      status: "pending",
      variables: {
        params: { path: { slug: "books" } },
        body: {
          base_revision: "detail-r1",
          view: "Reading",
          title: "",
          fields: {},
        },
      },
      submittedAt: 1,
    };
  }
  return {
    ...common,
    isIdle: true,
    isPending: false,
    status: "idle",
    variables: undefined,
    submittedAt: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function capability(
  view: string,
  fields: BaseMemberCapability["fields"],
  overrides: Partial<BaseMemberCapability> = {},
): BaseMemberCapability {
  return { view, enabled: true, fields, blockers: [], ...overrides };
}

function definition(
  overrides: Partial<BaseDetailResponse> = {},
): BaseDetailResponse {
  return {
    slug: "books",
    name: "Books",
    revision: "detail-r1",
    title_template: null,
    properties: [
      { key: "rating", definition: { type: "number" } },
      {
        key: "status",
        definition: { type: "select", options: ["queued", "reading"] },
      },
    ],
    views: [
      {
        name: "Reading",
        layout: "table",
        columns: ["title", "rating", "project"],
      },
      {
        name: "Shelf",
        layout: "table",
        columns: ["title", "status"],
      },
    ],
    diagnostics: [],
    member_creation: [
      capability("reading", [
        { field: "rating", membership: false, view: true, embed: false },
        { field: "project", membership: false, view: true, embed: false },
      ]),
      capability("Shelf", [
        { field: "status", membership: false, view: true, embed: false },
      ]),
    ],
    ...overrides,
  };
}

const createdMember: BaseMemberCreateResponse = {
  id: "page-1",
  path: "books/the-dispossessed.md",
  revision: "page-r1",
  title: "The Dispossessed",
};

const ratingDiagnostic = {
  scope: "field" as const,
  field: "rating",
  message: "Rating is outside the allowed range.",
};

vi.mock("#/api/bases", async (importOriginal) => {
  const actual = await importOriginal<typeof BasesApi>();
  return {
    ...actual,
    useBase: (slug: string) => {
      mocks.useBase(slug);
      return useBaseResult();
    },
    useCreateBaseMember: useCreateBaseMemberResult,
  };
});

vi.mock("#/lib/useProjects", () => ({
  useProjects: () => mocks.projects,
}));

import { BaseMemberIntake } from "#/components/bases/BaseMemberIntake";

async function enterTitle(user: UserEvent, title: string) {
  await user.type(
    screen.getByRole("textbox", { name: "New member — Title" }),
    title,
  );
}

async function enterRating(user: UserEvent, rating: string) {
  await user.click(
    screen.getByRole("button", { name: "Edit New member — Rating" }),
  );
  await user.type(
    screen.getByRole("spinbutton", { name: "New member — Rating" }),
    rating,
  );
}

async function save(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "Save new member" }));
}

async function chooseView(user: UserEvent, view: string) {
  await user.click(screen.getByRole("button", { name: /View/ }));
  await user.click(await screen.findByRole("option", { name: view }));
}

describe("BaseMemberIntake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMember.mockReset();
    mocks.refetchBase.mockReset();
    mocks.detail.data = definition();
    mocks.detail.error = null;
    mocks.detail.isLoading = false;
    mocks.detail.isFetching = false;
    mocks.mutation.isPending = false;
    mocks.refetchBase.mockImplementation(async () => useBaseResult());
  });

  it("blocks duplicate submission for the full conflict refresh and resubmits with the new revision", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const refresh = deferred<UseBaseResult>();
    mocks.createMember
      .mockRejectedValueOnce({
        status: 409,
        error: "The Base changed.",
        detail: {
          code: "base_revision_conflict",
          diagnostics: [ratingDiagnostic],
        },
      })
      .mockResolvedValue(createdMember);
    mocks.refetchBase.mockReturnValueOnce(refresh.promise);

    render(<BaseMemberIntake slug="books" onCreated={onCreated} />);
    await enterTitle(user, "The Dispossessed");
    await enterRating(user, "9");
    await save(user);
    await waitFor(() => expect(mocks.refetchBase).toHaveBeenCalledOnce());

    const title = screen.getByRole("textbox", {
      name: "New member — Title",
    });
    expect(title).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Cancel new member" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeDisabled();
    await user.type(title, " Revised");
    await user.keyboard("{Escape}");
    expect(title).toHaveValue("The Dispossessed Revised");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    const refreshed = definition({ revision: "detail-r2" });
    mocks.detail.data = refreshed;
    refresh.resolve(
      useBaseResult({
        data: refreshed,
        error: null,
        isLoading: false,
        isFetching: false,
      }),
    );

    expect(await screen.findByText("The Base changed.")).toBeVisible();
    expect(screen.getByText(ratingDiagnostic.message)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeEnabled();
    await save(user);

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(mocks.createMember.mock.calls).toEqual([
      [
        {
          params: { path: { slug: "books" } },
          body: {
            base_revision: "detail-r1",
            view: "Reading",
            title: "The Dispossessed",
            fields: { rating: 9 },
          },
        },
      ],
      [
        {
          params: { path: { slug: "books" } },
          body: {
            base_revision: "detail-r2",
            view: "Reading",
            title: "The Dispossessed Revised",
            fields: { rating: 9 },
          },
        },
      ],
    ]);
    expect(onCreated).toHaveBeenCalledWith(
      "books/the-dispossessed.md",
      "The Dispossessed",
    );
  });

  it("scopes an alternate view selection to the current Base slug", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mocks.createMember.mockResolvedValueOnce(createdMember);
    const { rerender } = render(
      <BaseMemberIntake slug="books" onCreated={onCreated} />,
    );
    await chooseView(user, "Shelf");

    mocks.detail.data = definition({
      slug: "authors",
      name: "Authors",
      revision: "authors-r1",
      views: [
        {
          name: "Roster",
          layout: "table",
          columns: ["title", "status"],
        },
      ],
      member_creation: [
        capability("roster", [
          { field: "status", membership: false, view: true, embed: false },
        ]),
      ],
    });
    rerender(<BaseMemberIntake slug="authors" onCreated={onCreated} />);

    expect(
      screen.getByRole("button", { name: "Edit New member — Status" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit New member — Rating" }),
    ).toBeNull();
    await enterTitle(user, "Ursula K. Le Guin");
    await save(user);

    await waitFor(() => expect(mocks.createMember).toHaveBeenCalledOnce());
    expect(mocks.createMember).toHaveBeenCalledWith({
      params: { path: { slug: "authors" } },
      body: {
        base_revision: "authors-r1",
        view: "Roster",
        title: "Ursula K. Le Guin",
        fields: {},
      },
    });
  });

  it("keeps the draft gated after conflict refresh removes the selected capability, then resubmits through a viable view", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mocks.createMember
      .mockRejectedValueOnce({
        status: 409,
        error: "The Base changed.",
        detail: { code: "base_revision_conflict" },
      })
      .mockResolvedValueOnce(createdMember);
    mocks.refetchBase.mockImplementationOnce(async () => {
      const refreshed = definition({
        revision: "detail-r2",
        member_creation: [
          capability("Shelf", [
            { field: "status", membership: false, view: true, embed: false },
          ]),
        ],
      });
      mocks.detail.data = refreshed;
      return useBaseResult({
        data: refreshed,
        error: null,
        isLoading: false,
        isFetching: false,
      });
    });

    render(<BaseMemberIntake slug="books" onCreated={onCreated} />);
    await enterTitle(user, "The Telling");
    await enterRating(user, "7");
    await save(user);

    expect(await screen.findByText("The Base changed.")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("The Telling");
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    expect(
      screen.getByRole("spinbutton", { name: "New member — Rating" }),
    ).toHaveValue(7);
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeDisabled();
    expect(screen.getByText("Member creation is unavailable for this view."))
      .toBeVisible();

    await chooseView(user, "Shelf");
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("The Telling");
    expect(
      screen.getByRole("button", { name: "Edit New member — Status" }),
    ).toBeVisible();
    await save(user);

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(mocks.createMember.mock.calls[1]).toEqual([
      {
        params: { path: { slug: "books" } },
        body: {
          base_revision: "detail-r2",
          view: "Shelf",
          title: "The Telling",
          fields: { rating: 7 },
        },
      },
    ]);
  });

  it("keeps authored controls mounted and Save disabled when conflict refresh disables the selected capability", async () => {
    const user = userEvent.setup();
    mocks.createMember.mockRejectedValueOnce({
      status: 409,
      error: "The Base changed.",
      detail: { code: "revision_conflict" },
    });
    mocks.refetchBase.mockImplementationOnce(async () => {
      const refreshed = definition({
        revision: "detail-r2",
        member_creation: [
          capability(
            "Reading",
            [
              {
                field: "rating",
                membership: false,
                view: true,
                embed: false,
              },
              {
                field: "project",
                membership: false,
                view: true,
                embed: false,
              },
            ],
            {
              enabled: false,
              blockers: [
                {
                  scope: "view",
                  message: "Reading is temporarily unavailable.",
                },
              ],
            },
          ),
          capability("Shelf", [
            { field: "status", membership: false, view: true, embed: false },
          ]),
        ],
      });
      mocks.detail.data = refreshed;
      return useBaseResult({
        data: refreshed,
        error: null,
        isLoading: false,
        isFetching: false,
      });
    });

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);
    await enterTitle(user, "Lavinia");
    await enterRating(user, "6");
    await save(user);

    expect(
      await screen.findByText("Reading is temporarily unavailable."),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("Lavinia");
    expect(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Cancel new member" }),
    ).toBeEnabled();
  });

  it("falls back to the first view and matches its capability case-insensitively", () => {
    mocks.detail.data = definition({
      views: [{ name: "Reading", layout: "table", columns: ["title"] }],
      member_creation: [
        capability("reading", [], {
          enabled: false,
          blockers: [
            {
              scope: "membership",
              message: "This view cannot create members.",
            },
          ],
        }),
      ],
    });

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This view cannot create members.",
    );
    expect(screen.queryByRole("form", { name: "New base member" })).toBeNull();
  });

  it("submits the exact normalized request and reports the created member", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mocks.createMember.mockResolvedValueOnce(createdMember);

    render(<BaseMemberIntake slug="books" onCreated={onCreated} />);
    await enterTitle(user, "  The Dispossessed  ");
    await user.type(
      screen.getByRole("combobox", { name: "New member — Project" }),
      "clepsydra{Enter}",
    );
    await save(user);

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(mocks.useBase).toHaveBeenCalledWith("books");
    expect(mocks.createMember.mock.calls).toEqual([
      [
        {
          params: { path: { slug: "books" } },
          body: {
            base_revision: "detail-r1",
            view: "Reading",
            title: "The Dispossessed",
            fields: { project: "clepsydra" },
          },
        },
      ],
    ]);
    expect(onCreated).toHaveBeenCalledWith(
      "books/the-dispossessed.md",
      "The Dispossessed",
    );
    expect(mocks.refetchBase).not.toHaveBeenCalled();
  });

  it("shows ordinary diagnostics without discarding authored values", async () => {
    const user = userEvent.setup();
    mocks.createMember.mockRejectedValueOnce({
      status: 422,
      error: "Candidate rejected.",
      detail: { diagnostics: [ratingDiagnostic] },
    });

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);
    await enterTitle(user, "The Left Hand of Darkness");
    await enterRating(user, "8");
    await save(user);

    expect(await screen.findByText("Candidate rejected.")).toBeVisible();
    expect(screen.getByText(ratingDiagnostic.message)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("The Left Hand of Darkness");
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    expect(
      screen.getByRole("spinbutton", { name: "New member — Rating" }),
    ).toHaveValue(8);
    expect(mocks.refetchBase).not.toHaveBeenCalled();
  });

  it("shows a failed conflict refresh without discarding authored values", async () => {
    const user = userEvent.setup();
    mocks.createMember.mockRejectedValueOnce({
      status: 409,
      error: "The Base changed.",
      detail: {
        code: "revision_conflict",
        diagnostics: [ratingDiagnostic],
      },
    });
    mocks.refetchBase.mockResolvedValueOnce(
      useBaseResult({
        data: undefined,
        error: new Error("Definition refresh failed."),
        isLoading: false,
        isFetching: false,
      }),
    );

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);
    await enterTitle(user, "The Lathe of Heaven");
    await save(user);

    expect(await screen.findByText("Definition refresh failed.")).toBeVisible();
    expect(screen.getByText(ratingDiagnostic.message)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("The Lathe of Heaven");
    expect(mocks.createMember).toHaveBeenCalledOnce();
    expect(mocks.refetchBase).toHaveBeenCalledOnce();
  });

  it("clears reports on view change and uses that view's capability and refreshed revision", async () => {
    const user = userEvent.setup();
    mocks.createMember
      .mockRejectedValueOnce({ status: 422, error: "Candidate rejected." })
      .mockResolvedValueOnce(createdMember);

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);
    await enterTitle(user, "Always Coming Home");
    await save(user);
    expect(await screen.findByText("Candidate rejected.")).toBeVisible();

    mocks.detail.data = definition({ revision: "detail-r2" });
    await chooseView(user, "Shelf");

    expect(screen.queryByText("Candidate rejected.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit New member — Rating" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit New member — Status" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("Always Coming Home");

    await save(user);
    await waitFor(() => expect(mocks.createMember).toHaveBeenCalledTimes(2));
    expect(mocks.createMember.mock.calls[1]).toEqual([
      {
        params: { path: { slug: "books" } },
        body: {
          base_revision: "detail-r2",
          view: "Shelf",
          title: "Always Coming Home",
          fields: {},
        },
      },
    ]);
  });

  it("clears reports on cancel without changing authored values", async () => {
    const user = userEvent.setup();
    mocks.createMember.mockRejectedValueOnce({
      status: 422,
      error: "Candidate rejected.",
      detail: { diagnostics: [ratingDiagnostic] },
    });

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);
    await enterTitle(user, "The Word for World Is Forest");
    await save(user);
    expect(await screen.findByText("Candidate rejected.")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Cancel new member" }),
    );

    expect(screen.queryByText("Candidate rejected.")).toBeNull();
    expect(screen.queryByText(ratingDiagnostic.message)).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("The Word for World Is Forest");
  });

  it("disables the mounted draft while creation is pending", () => {
    mocks.mutation.isPending = true;

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);

    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Cancel new member" }),
    ).toBeDisabled();
  });

  it("shows loading state before detail is available", () => {
    mocks.detail.data = undefined;
    mocks.detail.isLoading = true;

    render(<BaseMemberIntake slug="books" onCreated={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Base…");
    expect(screen.queryByRole("form", { name: "New base member" })).toBeNull();
  });

  it("shows the missing-Base state when detail is unavailable", () => {
    mocks.detail.data = undefined;

    render(<BaseMemberIntake slug="gone" onCreated={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "No Base named “gone” is available.",
    );
    expect(screen.queryByRole("form", { name: "New base member" })).toBeNull();
  });
});
