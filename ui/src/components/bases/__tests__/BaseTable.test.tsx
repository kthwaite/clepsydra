import { render, screen } from "@testing-library/react";
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

  commit: vi.fn(),
  refetchView: vi.fn(),
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
  properties: {
    status: { type: "select", options: ["queued", "reading"] },
    rating: { type: "number" },
  },
  views: [
    {
      name: "Continues",
      layout: "table",
      group_by: "status",
      columns: ["title", "kind", "status", "rating"],
    },
  ],
  diagnostics: [],
  member_creation: [
    {
      view: "continues",
      enabled: true,
      fields: [
        { field: "sys.kind", membership: true, view: false },
        { field: "prop.status", membership: false, view: true },
      ],
      blockers: [],
    },
  ],
};

vi.mock("#/api/bases", async (importOriginal) => {
  const actual = await importOriginal<typeof BasesApi>();
  return {
    ...actual,
    useBase: () => ({ data: definition, error: null, isLoading: false }),
    useBaseView: () => ({ ...mocks.viewState, refetch: mocks.refetchView }),
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
  await user.selectOptions(
    screen.getByRole("combobox", { name: "New member — Status" }),
    "reading",
  );
  await user.click(
    screen.getByRole("button", { name: "Edit New member — Rating" }),
  );
  await user.type(
    screen.getByRole("spinbutton", { name: "New member — Rating" }),
    "9{Enter}",
  );
  return title;
}

describe("BaseTable member creation", () => {
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
        fields: { kind: "BOOK", status: "reading", rating: 9 },
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
        fields: { kind: "BOOK", status: "reading", rating: 9 },
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
});
