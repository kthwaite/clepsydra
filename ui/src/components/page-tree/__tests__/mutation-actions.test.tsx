import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FolderActionsMenu } from "#/components/page-tree/FolderActionsMenu";
import { MutationPreviewDialog } from "#/components/page-tree/MutationPreviewDialog";
import { PageActionsMenu } from "#/components/page-tree/PageActionsMenu";

const mocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  deletePage: vi.fn(),
  moveFolder: vi.fn(),
  movePage: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("#/api/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/api/index")>();
  return {
    ...actual,
    usePreviewMutation: () => ({
      mutateAsync: mocks.preview,
      isPending: false,
    }),
  };
});

vi.mock("#/api/pages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/api/pages")>();
  return {
    ...actual,
    useDeletePage: () => ({
      mutateAsync: mocks.deletePage,
      isPending: false,
    }),
    useMovePage: () => ({
      mutateAsync: mocks.movePage,
      isPending: false,
    }),
  };
});

vi.mock("#/api/folders", () => ({
  useCreateFolder: () => ({
    mutateAsync: mocks.createFolder,
    isPending: false,
  }),
  useDeleteFolder: () => ({
    mutateAsync: mocks.deleteFolder,
    isPending: false,
  }),
  useFolderTreePaths: () => ({
    data: ["archive", "notes", "notes/research"],
    isLoading: false,
    error: null,
  }),
  useMoveFolder: () => ({
    mutateAsync: mocks.moveFolder,
    isPending: false,
  }),
}));

const movePreview = {
  file_ops: [
    {
      kind: "rename" as const,
      path: "notes/old.md",
      destination: "archive/new.md",
    },
  ],
  text_edits: [
    {
      path: "notes/index.md",
      old_text: "[[old]]",
      new_text: "[[new]]",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockResolvedValue(movePreview);
  mocks.movePage.mockResolvedValue({ path: "archive/new.md" });
  mocks.moveFolder.mockResolvedValue(undefined);
  mocks.createFolder.mockResolvedValue(undefined);
  mocks.deleteFolder.mockResolvedValue(undefined);
  mocks.deletePage.mockResolvedValue(undefined);
});

describe("MutationPreviewDialog", () => {
  it("shows affected paths, destructive warnings, and link rewrites", () => {
    render(
      <MutationPreviewDialog
        isOpen
        title="Review mutation"
        confirmLabel="Apply mutation"
        preview={{
          file_ops: [
            ...movePreview.file_ops,
            { kind: "delete", path: "notes/obsolete.md" },
          ],
          text_edits: movePreview.text_edits,
        }}
        isExecuting={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/1 path will be deleted/i)).toBeVisible();
    expect(screen.getByText(/1 link rewrite/i)).toBeVisible();
    expect(screen.getByText("notes/old.md")).toBeVisible();
    expect(screen.getByText("archive/new.md")).toBeVisible();
    expect(screen.getByText("notes/index.md")).toBeVisible();
    expect(screen.getByText(/Before: \[\[old\]\]/)).toBeVisible();
    expect(screen.getByText(/After: \[\[new\]\]/)).toBeVisible();
  });
});

describe("PageActionsMenu", () => {
  it("requires and displays a fresh preview before moving a page", async () => {
    const user = userEvent.setup();
    const onMoved = vi.fn();
    const events: string[] = [];
    const beforeMutation = vi.fn(async () => {
      events.push("save");
    });
    mocks.preview.mockImplementation(async () => {
      events.push("preview");
      return movePreview;
    });
    mocks.movePage.mockImplementation(async () => {
      events.push("move");
      return { path: "archive/new.md" };
    });
    render(
      <PageActionsMenu
        path="notes/old.md"
        beforeMutation={beforeMutation}
        onMoved={onMoved}
        onDeleted={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /move or rename page/i }),
    );
    await user.type(
      screen.getByRole("textbox", { name: /destination path/i }),
      "archive/new.md",
    );
    expect(mocks.movePage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /preview move/i }));
    expect(mocks.preview).toHaveBeenCalledWith({
      operation: "move_page",
      source: "notes/old.md",
      destination: "archive/new.md",
    });
    expect(await screen.findByText("notes/index.md")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /^move page$/i }));
    expect(mocks.movePage).toHaveBeenCalledWith({
      params: { path: { path: "notes/old.md" } },
      body: { destination: "archive/new.md" },
    });
    expect(onMoved).toHaveBeenCalledWith("archive/new.md");
    expect(events).toEqual(["save", "preview", "move"]);
  });

  it("previews the selected rewrite policy before deleting a page", async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    render(
      <PageActionsMenu
        path="notes/old.md"
        onMoved={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^delete page$/i }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: /inbound links/i }),
      "unlink",
    );
    await user.click(screen.getByRole("button", { name: /preview deletion/i }));

    expect(mocks.preview).toHaveBeenCalledWith({
      operation: "delete_page",
      source: "notes/old.md",
      rewrite: "unlink",
    });
    await user.click(screen.getByRole("button", { name: /confirm delete/i }));
    expect(mocks.deletePage).toHaveBeenCalledWith({
      params: {
        path: { path: "notes/old.md" },
        query: { force: true, rewrite: "unlink" },
      },
    });
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("discards a preview when the user returns to change the destination", async () => {
    const user = userEvent.setup();
    mocks.movePage.mockResolvedValue({ path: "archive/final.md" });
    render(
      <PageActionsMenu
        path="notes/old.md"
        onMoved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /move or rename page/i }),
    );
    const destination = screen.getByRole("textbox", {
      name: /destination path/i,
    });
    await user.type(destination, "archive/draft.md");
    await user.click(screen.getByRole("button", { name: /preview move/i }));
    await screen.findByRole("button", { name: /^move page$/i });
    await user.click(screen.getByRole("button", { name: /^back$/i }));

    const revisedDestination = screen.getByRole("textbox", {
      name: /destination path/i,
    });
    await user.clear(revisedDestination);
    await user.type(revisedDestination, "archive/final.md");
    expect(mocks.movePage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /preview move/i }));
    await user.click(
      await screen.findByRole("button", { name: /^move page$/i }),
    );

    expect(mocks.preview).toHaveBeenLastCalledWith({
      operation: "move_page",
      source: "notes/old.md",
      destination: "archive/final.md",
    });
    expect(mocks.movePage).toHaveBeenCalledWith({
      params: { path: { path: "notes/old.md" } },
      body: { destination: "archive/final.md" },
    });
  });
});

describe("FolderActionsMenu", () => {
  it("creates folders and previews folder moves", async () => {
    const user = userEvent.setup();
    render(<FolderActionsMenu />);
    await user.click(screen.getByRole("button", { name: /manage folders/i }));

    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: /new folder path/i }),
      "notes/new",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /create folder/i }),
    );
    expect(mocks.createFolder).toHaveBeenCalledWith({
      params: { path: { path: "notes/new" } },
    });

    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: /folder to move/i }),
      "notes",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: /folder destination/i }),
      "archive/notes",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /preview folder move/i }),
    );

    expect(mocks.preview).toHaveBeenCalledWith({
      operation: "move_folder",
      source: "notes",
      destination: "archive/notes",
    });
    await user.click(screen.getByRole("button", { name: /^move folder$/i }));
    expect(mocks.moveFolder).toHaveBeenCalledWith({
      params: { path: { path: "notes" } },
      body: { destination: "archive/notes" },
    });
  });

  it("uses an exact-name confirmation for unpreviewable folder deletion", async () => {
    const user = userEvent.setup();
    render(<FolderActionsMenu />);
    await user.click(screen.getByRole("button", { name: /manage folders/i }));
    const dialog = screen.getByRole("dialog");

    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: /folder to delete/i }),
      "notes/research",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /review folder deletion/i }),
    );
    expect(
      screen.getByText(/backend cannot preview folder deletion/i),
    ).toBeVisible();
    const confirm = screen.getByRole("textbox", {
      name: /type notes\/research to confirm/i,
    });
    await user.type(confirm, "notes/research");
    await user.click(
      screen.getByRole("checkbox", { name: /delete contents recursively/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /confirm folder deletion/i }),
    );

    await waitFor(() =>
      expect(mocks.deleteFolder).toHaveBeenCalledWith({
        params: {
          path: { path: "notes/research" },
          query: { recursive: true },
        },
      }),
    );
  });
});
