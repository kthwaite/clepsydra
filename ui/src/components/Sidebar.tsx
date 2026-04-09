import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  FilePlus,
  FolderPlus,
  ListChecks,
  Settings,
} from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { useTags } from "#/api/index";
import { useCreateFolder, useCreatePage } from "#/api/pages";
import { FileTree } from "#/components/FileTree";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useUiStore } from "#/store/ui";

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
  const openSettings = useUiStore((s) => s.openSettings);

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
      <Dialog
        isOpen={isDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeCreateDialog();
        }}
        title={dialogTitle}
        description={dialogDescription}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={closeCreateDialog}
              isDisabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="create-item-form"
              isDisabled={isSubmitting}
            >
              {isSubmitting
                ? "Creating..."
                : isCreatingNote
                  ? "Create Note"
                  : "Create Folder"}
            </Button>
          </>
        }
      >
        <form id="create-item-form" onSubmit={handleCreateSubmit}>
          <TextField
            label="Path"
            value={pathInput}
            onChange={setPathInput}
            placeholder={pathPlaceholder}
            autoFocus
            isDisabled={isSubmitting}
            description={pathHint}
            isInvalid={!!dialogError}
            errorMessage={dialogError ?? undefined}
          />
        </form>
      </Dialog>

      <div className="border-b border-border px-4 py-3">
        <Link
          to="/"
          className="text-sm font-bold uppercase tracking-widest text-foreground"
        >
          clepsydra
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <div className="mb-2 space-y-px">
          <Link
            to="/journal"
            className="flex w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground [&.active]:font-bold [&.active]:text-foreground"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Journal
          </Link>
          <Link
            to="/agenda"
            className="flex w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground [&.active]:font-bold [&.active]:text-foreground"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Agenda
          </Link>
        </div>
        <FileTree />
        <div className="mt-2 space-y-px border-t border-border pt-2">
          <Button
            variant="ghost"
            onPress={() => openCreateDialog("note")}
            className="w-full justify-start gap-1.5 px-2 py-1"
          >
            <FilePlus className="h-3.5 w-3.5" />
            New Note
          </Button>
          <Button
            variant="ghost"
            onPress={() => openCreateDialog("folder")}
            className="w-full justify-start gap-1.5 px-2 py-1"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New Folder
          </Button>
        </div>
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
      <div className="border-t border-border">
        <Button
          variant="ghost"
          onPress={() => openSettings()}
          className="w-full justify-start gap-1.5 px-3 py-2"
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </Button>
      </div>
    </aside>
  );
}
