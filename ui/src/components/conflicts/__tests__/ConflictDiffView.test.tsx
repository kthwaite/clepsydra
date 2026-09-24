import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ConflictCompare, SyncConflictApiError } from "#/api/sync";
import { ConflictDiffView } from "../ConflictDiffView";

const COPY = "notes/plan.conflict.abc1234.md";
const ORIGINAL = "notes/plan.md";

const mocks = vi.hoisted(() => ({
  compare: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  resolve: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null as unknown,
  },
  conflicts: undefined as unknown,
  navigate: vi.fn(),
  openTab: vi.fn(),
}));

vi.mock("#/api/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/sync")>()),
  useConflictCompare: () => mocks.compare,
  useResolveConflict: () => mocks.resolve,
}));

vi.mock("#/api/index", () => ({
  useSyncConflicts: () => ({ data: mocks.conflicts }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => mocks.openTab,
}));

function compareOf(local: string, other: string): ConflictCompare {
  return {
    copy_path: COPY,
    original_path: ORIGINAL,
    original_title: "Plan",
    local: { text: local, revision: "rev-local" },
    other: { text: other, revision: "rev-other" },
  };
}

function mergedResult(): string {
  const result = screen.getByRole("region", { name: "Result" });
  return result.querySelector("pre")?.textContent ?? "";
}

function apiError(status: number, message: string, code?: string) {
  return new SyncConflictApiError(
    { error: message, status, detail: code ? { code } : undefined },
    status,
  );
}

beforeEach(() => {
  mocks.compare.data = compareOf("a\nkeep\nlocal\nz\n", "a\nkeep\nother\nz\n");
  mocks.compare.isPending = false;
  mocks.compare.isError = false;
  mocks.compare.error = null;
  mocks.compare.refetch.mockReset();
  mocks.resolve.mutate.mockReset();
  mocks.resolve.reset.mockReset();
  mocks.resolve.isPending = false;
  mocks.resolve.error = null;
  mocks.conflicts = undefined;
  mocks.navigate.mockReset();
  mocks.openTab.mockReset();
});

describe("ConflictDiffView", () => {
  it("shows each hunk's local and other lines side by side", () => {
    render(<ConflictDiffView copyPath={COPY} />);

    expect(screen.getByText("1 change")).toBeInTheDocument();
    const hunk = screen.getByRole("group", { name: "Change 1 of 1" });
    expect(
      within(hunk).getByRole("figure", { name: "Local (this device)" }),
    ).toHaveTextContent("local");
    expect(
      within(hunk).getByRole("figure", { name: "Other (conflict copy)" }),
    ).toHaveTextContent("other");
    expect(
      within(hunk).getByRole("radiogroup", { name: "Keep for change 1" }),
    ).toBeInTheDocument();
    expect(mergedResult()).toBe("a\nkeep\nlocal\nz\n");
  });

  it("updates the result preview when a hunk takes Other or Both", async () => {
    const user = userEvent.setup();
    render(<ConflictDiffView copyPath={COPY} />);
    const group = screen.getByRole("radiogroup", { name: "Keep for change 1" });

    await user.click(within(group).getByRole("radio", { name: "Other" }));
    expect(mergedResult()).toBe("a\nkeep\nother\nz\n");

    await user.click(within(group).getByRole("radio", { name: "Both" }));
    expect(mergedResult()).toBe("a\nkeep\nlocal\nother\nz\n");
  });

  it("moves between choices with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<ConflictDiffView copyPath={COPY} />);
    const group = screen.getByRole("radiogroup", { name: "Keep for change 1" });

    await user.click(within(group).getByRole("radio", { name: "Local" }));
    await user.keyboard("{ArrowRight}");
    expect(within(group).getByRole("radio", { name: "Other" })).toBeChecked();
    expect(mergedResult()).toBe("a\nkeep\nother\nz\n");
  });

  it("takes every hunk from one side with All local / All other", async () => {
    const user = userEvent.setup();
    mocks.compare.data = compareOf("1\nx\n2\ny\n3\n", "1\nX\n2\nY\n3\n");
    render(<ConflictDiffView copyPath={COPY} />);
    expect(screen.getByText("2 changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All other" }));
    expect(mergedResult()).toBe("1\nX\n2\nY\n3\n");

    await user.click(screen.getByRole("button", { name: "All local" }));
    expect(mergedResult()).toBe("1\nx\n2\ny\n3\n");
  });

  it("collapses unchanged runs to three lines of context with an expander", async () => {
    const user = userEvent.setup();
    const head = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join(
      "",
    );
    mocks.compare.data = compareOf(`${head}mine\n`, `${head}theirs\n`);
    render(<ConflictDiffView copyPath={COPY} />);

    expect(screen.queryByText("line 7")).not.toBeInTheDocument();
    expect(screen.getAllByText("line 8").length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: "Show 7 unchanged lines" }),
    );
    expect(screen.getAllByText("line 1").length).toBeGreaterThan(0);
  });

  it("marks a line without a final newline", () => {
    mocks.compare.data = compareOf("a\nb\n", "a\nb");
    render(<ConflictDiffView copyPath={COPY} />);

    const hunk = screen.getByRole("group", { name: "Change 1 of 1" });
    expect(
      within(hunk).getByRole("figure", { name: "Other (conflict copy)" }),
    ).toHaveTextContent(/no newline at end/i);
    expect(
      within(hunk).getByRole("figure", { name: "Local (this device)" }),
    ).not.toHaveTextContent(/no newline at end/i);
  });

  it("resolves with the assembled merge and both revisions, then returns to the list", async () => {
    const user = userEvent.setup();
    mocks.resolve.mutate.mockImplementation(
      (_body: unknown, options?: { onSuccess?: () => void }) =>
        options?.onSuccess?.(),
    );
    render(<ConflictDiffView copyPath={COPY} />);
    await user.click(
      within(
        screen.getByRole("radiogroup", { name: "Keep for change 1" }),
      ).getByRole("radio", { name: "Other" }),
    );

    await user.click(screen.getByRole("button", { name: "Resolve" }));

    expect(mocks.resolve.mutate).toHaveBeenCalledWith(
      {
        copy: COPY,
        merged: "a\nkeep\nother\nz\n",
        original_revision: "rev-local",
        copy_revision: "rev-other",
      },
      expect.anything(),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/conflicts" });
  });

  it("offers a reload when a side changed since the view loaded (409)", async () => {
    const user = userEvent.setup();
    mocks.resolve.error = apiError(409, "stale", "revision_conflict");
    render(<ConflictDiffView copyPath={COPY} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "One side changed since this view loaded. Reload to compare again.",
    );
    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    expect(mocks.resolve.reset).toHaveBeenCalled();
    expect(mocks.compare.refetch).toHaveBeenCalled();
  });

  it("explains manual resolution when the server refuses (422)", async () => {
    const user = userEvent.setup();
    mocks.resolve.error = apiError(422, "encrypted", "resolve_by_hand");
    render(<ConflictDiffView copyPath={COPY} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/resolve it by hand/i);
    await user.click(within(alert).getByRole("button", { name: "Open copy" }));
    expect(mocks.openTab).toHaveBeenCalledWith("page", COPY, COPY);
    await user.click(
      within(alert).getByRole("button", { name: "Open original" }),
    );
    expect(mocks.openTab).toHaveBeenCalledWith("page", ORIGINAL, "Plan");
  });

  it("explains manual resolution when the compare itself is refused", () => {
    mocks.compare.data = undefined;
    mocks.compare.isError = true;
    mocks.compare.error = apiError(422, "encrypted", "resolve_by_hand");
    mocks.conflicts = {
      total: 1,
      items: [
        {
          path: COPY,
          title: null,
          original: ORIGINAL,
          original_title: "Plan",
          original_exists: true,
        },
      ],
    };
    render(<ConflictDiffView copyPath={COPY} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/resolve it by hand/i);
    expect(
      within(alert).getByRole("button", { name: "Open original" }),
    ).toBeInTheDocument();
  });

  it("shows the server's message verbatim for other failures", () => {
    const message =
      "notes/plan.md was saved, but the Conflict Copy could not be moved to the Rubbish Bin and remains";
    mocks.resolve.error = apiError(500, message);
    render(<ConflictDiffView copyPath={COPY} />);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("shows loading and not-found states", () => {
    mocks.compare.data = undefined;
    mocks.compare.isPending = true;
    const { rerender } = render(<ConflictDiffView copyPath={COPY} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);

    mocks.compare.isPending = false;
    mocks.compare.isError = true;
    mocks.compare.error = apiError(404, "no such conflict copy");
    rerender(<ConflictDiffView copyPath={COPY} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "no such conflict copy",
    );
  });
});
