import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictsPanel } from "../ConflictsPanel";

const mocks = vi.hoisted(() => ({
  data: undefined as undefined | { items: unknown[]; total: number },
  isPending: false,
  isError: false,
  openTab: vi.fn(),
}));

vi.mock("#/api/index", () => ({
  useSyncConflicts: () => ({
    data: mocks.data,
    isPending: mocks.isPending,
    isError: mocks.isError,
  }),
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => mocks.openTab,
}));

beforeEach(() => {
  mocks.data = undefined;
  mocks.isPending = false;
  mocks.isError = false;
  mocks.openTab.mockReset();
});

describe("ConflictsPanel", () => {
  it("lists copies with their originals and opens either", async () => {
    const user = userEvent.setup();
    mocks.data = {
      total: 1,
      items: [
        {
          path: "notes/plan.conflict.abc1234.md",
          title: "Plan (conflict abc1234)",
          original: "notes/plan.md",
          original_title: "Plan",
          original_exists: true,
        },
      ],
    };
    render(<ConflictsPanel />);

    expect(screen.getByText("Plan (conflict abc1234)")).toBeInTheDocument();
    expect(screen.getByText(/notes\/plan\.md/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open copy/i }));
    expect(mocks.openTab).toHaveBeenCalledWith(
      "page",
      "notes/plan.conflict.abc1234.md",
      "Plan (conflict abc1234)",
    );

    await user.click(screen.getByRole("button", { name: /open original/i }));
    expect(mocks.openTab).toHaveBeenCalledWith("page", "notes/plan.md", "Plan");
  });

  it("shows empty, loading, error and missing-original states", () => {
    mocks.isPending = true;
    const { rerender } = render(<ConflictsPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /loading conflict copies/i,
    );

    mocks.isPending = false;
    mocks.isError = true;
    rerender(<ConflictsPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /could not load conflict copies/i,
    );

    mocks.isError = false;
    mocks.data = { items: [], total: 0 };
    rerender(<ConflictsPanel />);
    expect(screen.getByText(/no conflict copies/i)).toBeInTheDocument();

    mocks.data = {
      total: 1,
      items: [
        {
          path: "notes/orphan.conflict.def5678.md",
          title: null,
          original: "notes/gone.md",
          original_title: null,
          original_exists: false,
        },
      ],
    };
    rerender(<ConflictsPanel />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText(/original missing/i)).toBeInTheDocument();
    expect(
      within(item).queryByRole("button", { name: /open original/i }),
    ).not.toBeInTheDocument();
    expect(
      within(item).getByRole("button", { name: /open copy/i }),
    ).toBeInTheDocument();
  });
});
