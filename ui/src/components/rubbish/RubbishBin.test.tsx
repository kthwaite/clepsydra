import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RubbishBin } from "#/components/rubbish/RubbishBin";
import { EMPTY_FILTER_STATE, type FilterState } from "#/lib/filters/model";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  restore: vi.fn(),
  purge: vi.fn(),
  empty: vi.fn(),
  openTab: vi.fn(),
}));

vi.mock("#/api/rubbish", () => ({
  useRubbishList: api.list,
  useRubbishItem: api.detail,
  useRestoreRubbishItem: api.restore,
  usePurgeRubbishItem: api.purge,
  useEmptyRubbish: api.empty,
}));

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => api.openTab }));

const alpha = {
  status: "valid" as const,
  item: {
    item_id: "11111111-1111-4111-8111-111111111111",
    page_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Alpha dossier",
    original_path: "projects/alpha.md",
    kind: "PROJECT",
    deleted_at: "2026-08-13T14:30:00Z",
    archive_url: null,
  },
};
const beta = {
  status: "valid" as const,
  item: {
    item_id: "22222222-2222-4222-8222-222222222222",
    page_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Beta note",
    original_path: "notes/beta.md",
    kind: "NOTE",
    deleted_at: "2026-08-12T10:00:00Z",
    archive_url: null,
  },
};
const invalid = {
  status: "invalid" as const,
  item_id: "invalid-ledger-entry",
  error: "manifest checksum does not match stored payload",
};

function mutation(mutateAsync = vi.fn(), isPending = false) {
  return { mutateAsync, isPending };
}

function setDefaultHooks() {
  api.list.mockReturnValue({
    data: [alpha, beta, invalid],
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  api.detail.mockImplementation((itemId: string | null) => ({
    data:
      itemId === alpha.item.item_id
        ? {
            item: alpha.item,
            preview: {
              body: "# Stored body\n\nThis is the bounded archived preview.",
              encrypted: false,
              read_only: true,
              truncated: true,
            },
          }
        : undefined,
    isPending: false,
    isError: false,
    error: null,
  }));
  api.restore.mockReturnValue(mutation());
  api.purge.mockReturnValue(mutation());
  api.empty.mockReturnValue(mutation());
}

/**
 * Local stateful harness standing in for the /rubbish route: RubbishBin is a
 * controlled component (filterState/onFilterChange are route-owned props),
 * so filter-interaction tests need a real state round-trip the same way the
 * route's useMemo/navigate wiring provides it in production.
 */
function ControlledRubbishBin({
  initial = EMPTY_FILTER_STATE,
}: {
  initial?: FilterState;
} = {}) {
  const [filterState, setFilterState] = useState<FilterState>(initial);
  return (
    <RubbishBin filterState={filterState} onFilterChange={setFilterState} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setDefaultHooks();
});

describe("RubbishBin", () => {
  it("renders the newest-first lifecycle ledger and deterministic invalid diagnostics", () => {
    render(<RubbishBin />);

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("Alpha dossier")).toBeVisible();
    expect(within(rows[0]).getByText("projects/alpha.md")).toBeVisible();
    // Kinds read in sentence case (kindDisplayLabel), never KIND_META caps.
    expect(within(rows[0]).getByText("Project")).toBeVisible();
    expect(within(rows[0]).queryByText("PROJECT")).toBeNull();
    expect(within(rows[1]).getByText("Note")).toBeVisible();
    expect(within(rows[1]).getByText("Beta note")).toBeVisible();

    const invalidRow = screen.getByText("Unreadable item").closest("li");
    if (!invalidRow) throw new Error("unreadable rubbish bin row missing");
    expect(within(invalidRow).getByText(invalid.error)).toBeVisible();
    expect(within(invalidRow).getByText(invalid.item_id)).toBeVisible();
    expect(within(invalidRow).queryByRole("button")).toBeNull();
    // Hot text never sits on sink: the unreadable row is a 5% hot tint.
    expect(invalidRow).toHaveClass("bg-hot/5");
    expect(invalidRow).not.toHaveClass("bg-sink");

    // Deletion time: fixed month names, machine-readable instant.
    const timestamp = within(rows[0]).getByText(/13 Aug 2026/);
    expect(timestamp.tagName).toBe("TIME");
    expect(timestamp).toHaveAttribute("datetime", alpha.item.deleted_at);
  });

  it("heads the bin with a serif title and an item count that says items stay until emptied", () => {
    render(<RubbishBin />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Rubbish bin" }),
    ).toBeVisible();
    expect(screen.getByText("Retained deletions")).toBeVisible();
    expect(
      screen.getByText("2 items · kept until you empty the bin"),
    ).toBeVisible();
  });

  it("marks the selected row with the accent tint", async () => {
    const user = userEvent.setup();
    render(<RubbishBin />);

    const row = screen.getByRole("button", { name: /Alpha dossier/ });
    await user.click(row);

    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveClass("bg-accent-tint", "rounded-xl");
  });

  it("sentence-cases a stored kind the app no longer knows", () => {
    api.list.mockReturnValue({
      data: [{ ...beta, item: { ...beta.item, kind: "LEGACY_MEMO" } }],
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<RubbishBin />);

    expect(screen.getByText("Legacy memo")).toBeVisible();
  });

  it("fetches dedicated detail on selection and renders a bounded read-only preview", async () => {
    const user = userEvent.setup();
    render(<RubbishBin />);

    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));

    expect(api.detail).toHaveBeenLastCalledWith(alpha.item.item_id);
    expect(
      screen.getByRole("heading", { name: "Alpha dossier" }),
    ).toBeVisible();
    expect(screen.getByText(alpha.item.page_id)).toBeVisible();
    expect(screen.getByText("Retained page, read only")).toBeVisible();
    const metadata = screen.getByText("Original path").closest("dl");
    if (!metadata) throw new Error("metadata list missing");
    expect(
      within(metadata).getByText("Kind").nextElementSibling,
    ).toHaveTextContent("Project");
    expect(
      screen.getByRole("heading", { level: 3, name: "Stored body" }),
    ).toBeVisible();
    expect(screen.getByText(/preview is truncated/i)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /page body/i })).toBeNull();
  });

  it("keeps a tall non-truncated preview keyboard-scrollable and fully reachable", async () => {
    const bottomMarker = "BOTTOM OF STORED PREVIEW";
    api.detail.mockReturnValue({
      data: {
        item: alpha.item,
        preview: {
          body: `${Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n")}\n\n${bottomMarker}`,
          encrypted: false,
          read_only: true,
          truncated: false,
        },
      },
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(<RubbishBin />);

    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));

    const preview = screen.getByLabelText("Read-only stored body preview");
    expect(preview).toHaveClass("overflow-y-auto");
    expect(preview).not.toHaveClass("pointer-events-none");
    expect(within(preview).getByText(bottomMarker)).toBeInTheDocument();
    expect(screen.queryByText(/preview is truncated/i)).toBeNull();
  });

  it("states loading, list failure, empty, and detail failure explicitly", async () => {
    api.list.mockReturnValueOnce({ data: undefined, isPending: true });
    const loading = render(<RubbishBin />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading rubbish bin");

    api.list.mockReturnValueOnce({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("catalog offline"),
      refetch: vi.fn(),
    });
    loading.rerender(<RubbishBin />);
    expect(screen.getByRole("alert")).toHaveTextContent("catalog offline");

    api.list.mockReturnValueOnce({
      data: [],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });
    loading.rerender(<RubbishBin />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Rubbish bin is empty",
    );

    setDefaultHooks();
    api.detail.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("stored payload unreadable"),
    });
    loading.rerender(<RubbishBin />);
    await userEvent.click(
      screen.getByRole("button", { name: /Alpha dossier/ }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "stored payload unreadable",
    );
  });

  it("restores only through the item API, removes the row, and opens the returned normal path", async () => {
    const restore = vi.fn().mockResolvedValue({
      item_id: alpha.item.item_id,
      page_id: alpha.item.page_id,
      path: alpha.item.original_path,
    });
    api.restore.mockReturnValue(mutation(restore));
    const user = userEvent.setup();
    render(<RubbishBin />);

    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(restore).toHaveBeenCalledWith(alpha.item.item_id);
    expect(screen.queryByRole("button", { name: /Alpha dossier/ })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Open restored page" }),
    );
    expect(api.openTab).toHaveBeenCalledWith(
      "page",
      alpha.item.original_path,
      "Alpha dossier",
    );
    expect(api.openTab).not.toHaveBeenCalledWith(
      expect.anything(),
      alpha.item.item_id,
      expect.anything(),
    );
  });

  it("retains a restore conflict and names the occupied original path", async () => {
    const restore = vi.fn().mockRejectedValue({
      status: 409,
      error: "Original path projects/alpha.md is occupied",
    });
    api.restore.mockReturnValue(mutation(restore));
    const user = userEvent.setup();
    render(<RubbishBin />);

    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "projects/alpha.md is occupied",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Move or rename the page at projects/alpha.md, then restore again.",
    );
    expect(
      screen.getByRole("heading", { name: "Alpha dossier" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Alpha dossier/ })).toBeVisible();
  });

  it("retains item-drift conflicts with distinct refresh-and-retry guidance", async () => {
    api.restore.mockReturnValue(
      mutation(
        vi.fn().mockRejectedValue({
          status: 409,
          error: "retained item state changed while restoring",
        }),
      ),
    );
    const user = userEvent.setup();
    render(<RubbishBin />);

    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));
    await user.click(screen.getByRole("button", { name: "Restore" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "retained item state changed while restoring",
    );
    expect(alert).toHaveTextContent(
      "The item remains in the rubbish bin. Refresh the bin and retry.",
    );
    expect(screen.getByRole("button", { name: /Alpha dossier/ })).toBeVisible();
  });

  it("requires a page-specific permanent-delete confirmation", async () => {
    const purge = vi.fn().mockResolvedValue({
      item_id: alpha.item.item_id,
      page_id: alpha.item.page_id,
      original_path: alpha.item.original_path,
    });
    api.purge.mockReturnValue(mutation(purge));
    const user = userEvent.setup();
    render(<RubbishBin />);

    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));
    await user.click(
      screen.getByRole("button", { name: "Delete permanently…" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Alpha dossier");
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    await user.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );
    expect(purge).toHaveBeenCalledWith(alpha.item.item_id);
    expect(screen.queryByRole("button", { name: /Alpha dossier/ })).toBeNull();
  });

  it("locks permanent-delete confirmation while its request is pending", async () => {
    const purge = vi.fn(() => new Promise<never>(() => undefined));
    api.purge.mockReturnValue(mutation(purge));
    const user = userEvent.setup();
    const view = render(<RubbishBin />);
    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));
    await user.click(
      screen.getByRole("button", { name: "Delete permanently…" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete permanently",
      }),
    );

    api.purge.mockReturnValue(mutation(purge, true));
    view.rerender(<RubbishBin />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Deleting permanently",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("disables every lifecycle entry point while any lifecycle request is active", async () => {
    api.restore.mockReturnValue(mutation(vi.fn(), true));
    const user = userEvent.setup();
    render(<RubbishBin />);

    expect(
      screen.getByRole("button", { name: "Empty rubbish bin…" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Alpha dossier/ }));
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete permanently…" }),
    ).toBeDisabled();
  });

  it("uses a stronger count-aware Empty Bin confirmation and preserves ordered outcomes", async () => {
    const empty = vi.fn().mockResolvedValue({
      outcomes: [
        {
          status: "purged",
          item: {
            item_id: alpha.item.item_id,
            page_id: alpha.item.page_id,
            original_path: alpha.item.original_path,
          },
        },
        {
          status: "failed",
          item_id: beta.item.item_id,
          error: "snapshot is still referenced",
        },
      ],
    });
    api.empty.mockReturnValue(mutation(empty));
    const user = userEvent.setup();
    render(<RubbishBin />);

    await user.click(
      screen.getByRole("button", { name: "Empty rubbish bin…" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("2 items");
    expect(dialog).toHaveTextContent(/permanently delete every valid item/i);
    await user.click(
      within(dialog).getByRole("button", {
        name: "Empty rubbish bin permanently",
      }),
    );

    const outcomes = screen.getAllByRole("listitem", {
      name: /empty outcome/i,
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toHaveTextContent("projects/alpha.md");
    expect(outcomes[0]).toHaveTextContent("Deleted permanently");
    expect(outcomes[1]).toHaveTextContent(beta.item.item_id);
    expect(outcomes[1]).toHaveTextContent("snapshot is still referenced");
    expect(screen.queryByRole("button", { name: /Alpha dossier/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Beta note/ })).toBeVisible();
    const completion = screen.getByRole("status", {
      name: "Empty Bin completion",
    });
    expect(completion).toHaveTextContent("1 deleted permanently; 1 failed.");
    await waitFor(() =>
      expect(screen.getByLabelText("Empty Bin results")).toHaveFocus(),
    );
  });

  it("locks Empty Bin confirmation and announces pending work", async () => {
    const empty = vi.fn(() => new Promise<never>(() => undefined));
    api.empty.mockReturnValue(mutation(empty));
    const user = userEvent.setup();
    const view = render(<RubbishBin />);
    await user.click(
      screen.getByRole("button", { name: "Empty rubbish bin…" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Empty rubbish bin permanently",
      }),
    );

    api.empty.mockReturnValue(mutation(empty, true));
    view.rerender(<RubbishBin />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Deleting 2 retained items",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});

describe("RubbishBin — shared FilterBar composition", () => {
  it("narrows the ledger to items of the selected kind", async () => {
    const user = userEvent.setup();
    render(<ControlledRubbishBin />);

    const chip = screen.getByTestId("filter-bar-chip-kind");
    expect(chip).toHaveTextContent("Kind");
    expect(chip).not.toHaveTextContent("KIND");
    await user.click(chip);
    const option = screen.getByTestId("filter-bar-option-kind-PROJECT");
    expect(option).toHaveTextContent("Project");
    await user.click(option);

    expect(screen.getByRole("button", { name: /Alpha dossier/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Beta note/ })).toBeNull();
  });

  it("matches free text against both the title and the original path", async () => {
    const user = userEvent.setup();
    render(<ControlledRubbishBin />);
    const input = screen.getByTestId("filter-bar-input");

    // "dossier" only appears in Alpha's title, not either item's path.
    await user.type(input, "dossier");
    expect(screen.getByRole("button", { name: /Alpha dossier/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Beta note/ })).toBeNull();

    // "notes" only appears in Beta's original_path, not either item's title.
    await user.clear(input);
    await user.type(input, "notes");
    expect(screen.getByRole("button", { name: /Beta note/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Alpha dossier/ })).toBeNull();
  });

  it("renders an invalid entry normally with no filter, then hides it once any filter is active", async () => {
    const user = userEvent.setup();
    render(<ControlledRubbishBin />);

    expect(screen.getByText("Unreadable item")).toBeVisible();

    await user.type(screen.getByTestId("filter-bar-input"), "alpha");

    expect(screen.queryByText("Unreadable item")).toBeNull();
  });

  it("shows the filtered-empty state when no item matches the filter", async () => {
    const user = userEvent.setup();
    render(<ControlledRubbishBin />);

    await user.type(
      screen.getByTestId("filter-bar-input"),
      "no such retained page",
    );

    expect(screen.getByText(/no items match the filter/i)).toBeVisible();
  });
});
