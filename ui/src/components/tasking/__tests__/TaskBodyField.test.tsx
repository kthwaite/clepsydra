import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pageState } = vi.hoisted(() => ({
  pageState: {
    data: undefined as
      | { body: string; encrypted: boolean; path: string }
      | undefined,
    isLoading: false,
    isError: false,
  },
}));

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock("#/editor/useResolveWikilinkTarget", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useResolveWikilinkTarget: () => ({ resolve: resolveMock }),
}));

const { outlinksState } = vi.hoisted(() => ({
  outlinksState: {
    data: [] as Array<{
      kind: string;
      target_raw: string;
      target_path: string | null;
    }>,
  },
}));
const useOutlinksMock = vi.fn((_path: string) => ({
  ...outlinksState,
  refetch: async () => outlinksState,
}));
vi.mock("#/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOutlinks: (path: string) => useOutlinksMock(path),
}));

const usePageMock = vi.fn((_path: string) => pageState);
vi.mock("#/api/pages", () => ({
  usePage: (path: string) => usePageMock(path),
}));

import { TaskBodyField } from "../TaskBodyField";

beforeEach(() => {
  usePageMock.mockClear();
  useOutlinksMock.mockClear();
  resolveMock.mockReset().mockResolvedValue(null);
  outlinksState.data = [];
  pageState.data = undefined;
  pageState.isLoading = false;
  pageState.isError = false;
});

describe("TaskBodyField", () => {
  it("renders the full page body as read-only markdown", () => {
    pageState.data = {
      path: "tasks/t.md",
      encrypted: false,
      body: "Intro with **bold**.\n\n- [ ] a check\n\nSee [[Other Page]].\n",
    };

    render(<TaskBodyField path="tasks/t.md" onOpenPage={vi.fn()} />);

    expect(usePageMock).toHaveBeenCalledWith("tasks/t.md");
    const body = screen.getByTestId("edit-panel-body");
    expect(body).toHaveTextContent("Intro with bold.");
    expect(body.querySelector("strong")).toHaveTextContent("bold");
    // Checklist items stay: this is the full body, not the card description.
    expect(body).toHaveTextContent("a check");
    const box = body.querySelector('input[type="checkbox"]');
    expect(box).toBeDisabled();
    expect(body.querySelector("textarea, [contenteditable='true']")).toBeNull();
  });

  it("opens a linked page through onOpenPage", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    resolveMock.mockResolvedValue({
      path: "notes/other-page.md",
      title: "Other Page",
    });
    pageState.data = {
      path: "tasks/t.md",
      encrypted: false,
      body: "See [[Other Page]].",
    };

    render(<TaskBodyField path="tasks/t.md" onOpenPage={onOpenPage} />);
    await user.click(screen.getByRole("link", { name: "Other Page" }));

    await waitFor(() =>
      expect(onOpenPage).toHaveBeenCalledWith("notes/other-page.md"),
    );
  });

  it("resolves links through the Task page's indexed outlinks", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    outlinksState.data = [
      {
        kind: "wiki",
        target_raw: "TSK-brave-finch",
        target_path: "tasks/brave-finch.md",
      },
    ];
    pageState.data = {
      path: "tasks/t.md",
      encrypted: false,
      body: "Blocked on [[TSK-brave-finch]].",
    };

    render(<TaskBodyField path="tasks/t.md" onOpenPage={onOpenPage} />);
    await user.click(screen.getByRole("link", { name: "TSK-brave-finch" }));

    expect(useOutlinksMock).toHaveBeenCalledWith("tasks/t.md");
    expect(onOpenPage).toHaveBeenCalledWith("tasks/brave-finch.md");
    // Indexed resolution answers directly; no title search.
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("states an empty body", () => {
    pageState.data = { path: "tasks/t.md", encrypted: false, body: "  \n" };
    render(<TaskBodyField path="tasks/t.md" />);
    expect(screen.getByTestId("edit-panel-body")).toHaveTextContent(
      "Empty page",
    );
  });

  it("does not render an encrypted body", () => {
    pageState.data = {
      path: "tasks/t.md",
      encrypted: true,
      body: "age-encryption.org/v1 ciphertext",
    };
    render(<TaskBodyField path="tasks/t.md" />);
    const body = screen.getByTestId("edit-panel-body");
    expect(body).toHaveTextContent("Protected note");
    expect(body).not.toHaveTextContent("ciphertext");
  });

  it("shows loading and error states", () => {
    pageState.isLoading = true;
    const view = render(<TaskBodyField path="tasks/t.md" />);
    expect(screen.getByTestId("edit-panel-body")).toHaveTextContent("Loading…");

    pageState.isLoading = false;
    pageState.isError = true;
    view.rerender(<TaskBodyField path="tasks/t.md" />);
    expect(screen.getByTestId("edit-panel-body")).toHaveTextContent(
      "Could not load the page body.",
    );
  });
});
