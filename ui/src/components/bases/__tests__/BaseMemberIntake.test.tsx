import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BasesApi from "#/api/bases";
import type {
  BaseDetailResponse,
  BaseMemberCapability,
  BaseMemberCreateResponse,
} from "#/api/bases";

const mocks = vi.hoisted(() => ({
  createMember: vi.fn(),
  refetchBase: vi.fn(),
  useBase: vi.fn(),
  projects: ["clepsydra", "vessel"],
  detail: {
    data: undefined as BaseDetailResponse | undefined,
    error: null as unknown,
    isLoading: false,
  },
  mutation: { isPending: false },
}));

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
      return {
        data: mocks.detail.data,
        error: mocks.detail.error,
        isLoading: mocks.detail.isLoading,
        isFetching: false,
        refetch: mocks.refetchBase,
      };
    },
    useCreateBaseMember: () => ({
      data: undefined,
      error: null,
      isError: false,
      isIdle: !mocks.mutation.isPending,
      isPending: mocks.mutation.isPending,
      isSuccess: false,
      status: mocks.mutation.isPending ? "pending" : "idle",
      mutate: vi.fn(),
      mutateAsync: mocks.createMember,
      reset: vi.fn(),
    }),
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
    mocks.mutation.isPending = false;
    mocks.refetchBase.mockImplementation(async () => ({
      data: mocks.detail.data,
      error: null,
    }));
  });

  it("refreshes a revision conflict, preserves the draft, and resubmits with the new revision", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const conflict = {
      status: 409,
      error: "The Base changed.",
      detail: {
        code: "base_revision_conflict",
        diagnostics: [ratingDiagnostic],
      },
    };
    mocks.createMember
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(createdMember);
    mocks.refetchBase.mockImplementationOnce(async () => {
      const refreshed = definition({ revision: "detail-r2" });
      mocks.detail.data = refreshed;
      return { data: refreshed, error: null };
    });

    render(<BaseMemberIntake slug="books" onCreated={onCreated} />);
    await enterTitle(user, "The Dispossessed");
    await enterRating(user, "9");
    await save(user);

    expect(await screen.findByText("The Base changed.")).toBeVisible();
    expect(screen.getByText(ratingDiagnostic.message)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("The Dispossessed");
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    expect(
      screen.getByRole("spinbutton", { name: "New member — Rating" }),
    ).toHaveValue(9);

    await save(user);

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
            title: "The Dispossessed",
            fields: { rating: 9 },
          },
        },
      ],
    ]);
    expect(mocks.refetchBase).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(
      "books/the-dispossessed.md",
      "The Dispossessed",
    );
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
    mocks.refetchBase.mockResolvedValueOnce({
      data: undefined,
      error: new Error("Definition refresh failed."),
    });

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
