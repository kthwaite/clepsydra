import { Link, useLocation } from "@tanstack/react-router";
import { FilePlus, FolderPlus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { useTags } from "#/api/index";
import { useCreateFolder, useCreatePage } from "#/api/pages";
import { FileTree } from "#/components/FileTree";
import { ModalDialog } from "#/components/ModalDialog";
import { useOpenTab } from "#/hooks/useOpenTab";

type CreateTarget = "note" | "folder";

function formatMutationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Request failed";
}

export function Sidebar() {
  const { data: tags } = useTags();
  const createPage = useCreatePage();
  const createFolder = useCreateFolder();
  const openTab = useOpenTab();
  const location = useLocation();
  const pagesActive =
    location.pathname === "/" ||
    location.pathname.startsWith("/pages/") ||
    location.pathname === "/workspace";

  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);

  const isDialogOpen = createTarget !== null;
  const isSubmitting = createPage.isPending || createFolder.isPending;
  const isCreatingNote = createTarget === "note";

  const dialogTitle = isCreatingNote ? "Create New Note" : "Create New Folder";
  const dialogDescription = isCreatingNote
    ? "Create a new markdown page using a vault-relative path."
    : "Create a new folder using a vault-relative path.";
  const pathPlaceholder = isCreatingNote
    ? "notes/new-note.md"
    : "notes/subfolder";
  const pathHint = isCreatingNote
    ? "Example: notes/new-note.md"
    : "Example: notes/subfolder";

  function openCreateDialog(target: CreateTarget) {
    setCreateTarget(target);
    setPathInput("");
    setDialogError(null);
  }

  function closeCreateDialog() {
    if (isSubmitting) return;
    setCreateTarget(null);
    setPathInput("");
    setDialogError(null);
  }

  function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const path = pathInput.trim();
    if (!path) {
      setDialogError("Path is required.");
      return;
    }

    setDialogError(null);

    if (createTarget === "note") {
      createPage.mutate(
        { params: { path: { path } }, body: {} },
        {
          onSuccess: () => {
            setCreateTarget(null);
            setPathInput("");
            openTab("page", path);
          },
          onError: (error) => setDialogError(formatMutationError(error)),
        },
      );
      return;
    }

    if (createTarget === "folder") {
      createFolder.mutate(
        { params: { path: { path } } },
        {
          onSuccess: () => {
            setCreateTarget(null);
            setPathInput("");
          },
          onError: (error) => setDialogError(formatMutationError(error)),
        },
      );
    }
  }

  return (
    <aside className="flex w-64 flex-col border-r border-border bg-card">
      <ModalDialog
        isOpen={isDialogOpen}
        title={dialogTitle}
        description={dialogDescription}
        onClose={closeCreateDialog}
        footer={
          <>
            <button
              type="button"
              onClick={closeCreateDialog}
              disabled={isSubmitting}
              className="border border-border px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="create-item-form"
              disabled={isSubmitting}
              className="border border-border bg-primary px-3 py-1.5 text-xs uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting
                ? "Creating..."
                : isCreatingNote
                  ? "Create Note"
                  : "Create Folder"}
            </button>
          </>
        }
      >
        <form id="create-item-form" onSubmit={handleCreateSubmit}>
          <label
            htmlFor="create-item-path"
            className="block text-xs font-bold uppercase tracking-widest text-muted-foreground"
          >
            Path
          </label>
          <input
            id="create-item-path"
            type="text"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder={pathPlaceholder}
            autoFocus
            disabled={isSubmitting}
            className="mt-2 w-full border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p className="mt-2 text-xs text-muted-foreground">{pathHint}</p>
          {dialogError && (
            <p className="mt-2 text-xs text-destructive">{dialogError}</p>
          )}
        </form>
      </ModalDialog>

      <div className="border-b border-border px-4 py-3">
        <Link
          to="/"
          className="text-sm font-bold uppercase tracking-widest text-foreground"
        >
          clepsydra
        </Link>
      </div>
      <div className="flex border-b border-border">
        <Link
          to="/"
          className={`flex-1 px-3 py-1.5 text-center text-xs uppercase tracking-wider hover:bg-accent ${pagesActive ? "bg-accent font-bold" : ""}`}
        >
          Pages
        </Link>
        <button
          type="button"
          onClick={() => openTab("graph")}
          className="flex-1 border-l border-border px-3 py-1.5 text-center text-xs uppercase tracking-wider hover:bg-accent"
        >
          Graph
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <FileTree />
      </nav>
      <div className="border-t border-border px-2 py-2">
        {tags && tags.length > 0 && (
          <>
            <p className="mb-1 px-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Tags
            </p>
            <ul className="space-y-px">
              {tags.slice(0, 15).map((t) => (
                <li
                  key={t.tag}
                  className="flex items-center justify-between px-2 py-0.5 text-xs"
                >
                  <span>{t.tag}</span>
                  <span className="text-muted-foreground">{t.count}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="flex border-t border-border">
        <button
          type="button"
          onClick={() => openCreateDialog("note")}
          className="flex flex-1 items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FilePlus className="h-3.5 w-3.5" />
          New Note
        </button>
        <button
          type="button"
          onClick={() => openCreateDialog("folder")}
          className="flex flex-1 items-center justify-center gap-1.5 border-l border-border py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New Folder
        </button>
      </div>
    </aside>
  );
}
