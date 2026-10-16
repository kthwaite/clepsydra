import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_FIXTURE,
  FIXTURE_COL_LABEL,
  PROJECT_SCOPES,
} from "#/components/tasking/__tests__/fixtures";
import { TaskEditPanel } from "#/components/tasking/TaskEditPanel";
import { useBoardStore } from "#/store/board";
import type { OpenTabTarget } from "#/store/workspace";
import { useWorkspaceStore } from "#/store/workspace";

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

function openPage(path: string, label?: string, target?: OpenTabTarget) {
  useWorkspaceStore.getState().openTab("page", path, label, target);
}

beforeEach(() => {
  useWorkspaceStore.setState({
    tabs: [],
    activeTabId: null,
    openHistory: [],
    navigationMode: "new",
  });
  usePageMock.mockClear();
  useOutlinksMock.mockClear();
  resolveMock.mockReset().mockResolvedValue(null);
  outlinksState.data = [];
  pageState.data = undefined;
  pageState.isLoading = false;
  pageState.isError = false;
});

describe("TaskBodyField", () => {
  it.each([
    ["whole task", "", undefined, undefined],
    ["heading", "#Details", "Details", undefined],
    ["block", "#%5Eabc123DEF0", undefined, "abc123DEF0"],
  ])(
    "opens a %s body link at the appropriate task or page destination",
    async (_kind, fragment, heading, blockId) => {
      const task = BOARD_FIXTURE.tasks[0];
      assert(task);
      pageState.data = {
        path: task.path,
        encrypted: false,
        body: `[Linked task](/pages/tasks%2Ft2.md${fragment})`,
      };
      useBoardStore.setState({ editTaskId: task.id });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <TaskEditPanel
            task={task}
            tasks={BOARD_FIXTURE.tasks}
            projects={PROJECT_SCOPES}
            cycles={BOARD_FIXTURE.cycles}
            colLabel={FIXTURE_COL_LABEL}
            onClose={() => {}}
            onOpenPage={openPage}
          />
        </QueryClientProvider>,
      );
      await userEvent.click(screen.getByRole("link", { name: "Linked task" }));
      if (!fragment) {
        expect(useBoardStore.getState().editTaskId).toBe("t2");
        expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
      } else {
        expect(useBoardStore.getState().editTaskId).toBe(task.id);
        expect(useWorkspaceStore.getState().tabs).toContainEqual(
          expect.objectContaining({
            path: "tasks/t2.md",
            ...(heading ? { focusHeading: heading } : {}),
            ...(blockId ? { focusBlockId: blockId } : {}),
          }),
        );
      }
    },
  );

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

  it("opens a linked passage in the workspace rather than losing its heading", async () => {
    const user = userEvent.setup();
    resolveMock.mockResolvedValue({
      path: "notes/other-page.md",
      title: "Other Page",
    });
    pageState.data = {
      path: "tasks/t.md",
      encrypted: false,
      body: "See [[Other Page#Details|Other Page]].",
    };

    render(<TaskBodyField path="tasks/t.md" onOpenPage={openPage} />);
    await user.click(screen.getByRole("link", { name: "Other Page" }));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().tabs).toContainEqual(
        expect.objectContaining({
          path: "notes/other-page.md",
          focusHeading: "Details",
        }),
      ),
    );
  });

  it("resolves links through the Task page's indexed outlinks", async () => {
    const user = userEvent.setup();
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

    render(<TaskBodyField path="tasks/t.md" onOpenPage={openPage} />);
    await user.click(screen.getByRole("link", { name: "TSK-brave-finch" }));

    expect(useWorkspaceStore.getState().tabs).toContainEqual(
      expect.objectContaining({ path: "tasks/brave-finch.md" }),
    );
    // Indexed resolution answers directly; no title search.
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("opens an internal block address with a workspace focus request", async () => {
    pageState.data = {
      path: "tasks/t.md",
      encrypted: false,
      body: "[Evidence](/pages/notes%2Fevidence.md#%5Eabc123DEF0)",
    };
    render(<TaskBodyField path="tasks/t.md" onOpenPage={openPage} />);
    await userEvent.click(screen.getByRole("link", { name: "Evidence" }));
    expect(useWorkspaceStore.getState().tabs).toContainEqual(
      expect.objectContaining({
        path: "notes/evidence.md",
        focusBlockId: "abc123DEF0",
      }),
    );
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
