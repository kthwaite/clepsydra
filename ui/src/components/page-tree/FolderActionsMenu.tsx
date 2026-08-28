import { useId, useState } from "react";
import {
  useCreateFolder,
  useDeleteFolder,
  useFolderTreePaths,
  useMoveFolder,
} from "#/api/folders";
import {
  type MutationPreview,
  type MutationPreviewRequest,
  usePreviewMutation,
} from "#/api/index";
import { MutationPreviewDialog } from "#/components/page-tree/MutationPreviewDialog";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Dialog } from "#/components/ui/dialog";
import { Select, SelectItem } from "#/components/ui/select";
import { TextField } from "#/components/ui/text-field";

function mutationError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Request failed.";
}

function FolderSelect({
  id,
  label,
  value,
  paths,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  paths: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      id={id}
      label={label}
      selectedKey={value}
      onSelectionChange={(key) => onChange(key as string)}
      isDisabled={disabled}
      className="w-full"
    >
      <SelectItem id="">Select a folder</SelectItem>
      {paths.map((path) => (
        <SelectItem key={path} id={path}>
          {path}
        </SelectItem>
      ))}
    </Select>
  );
}

export function FolderActionsMenu({
  beforeMutation,
  onMoved,
  onDeleted,
}: {
  beforeMutation?: () => Promise<void>;
  onMoved?: (source: string, destination: string) => void;
  onDeleted?: (source: string) => void;
} = {}) {
  const id = useId();
  const {
    data: paths = [],
    isLoading,
    error: treeError,
  } = useFolderTreePaths();
  const createFolder = useCreateFolder();
  const moveFolder = useMoveFolder();
  const deleteFolder = useDeleteFolder();
  const previewMutation = usePreviewMutation();
  const [isOpen, setIsOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [moveSource, setMoveSource] = useState("");
  const [moveDestination, setMoveDestination] = useState("");
  const [deleteSource, setDeleteSource] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frozenMove, setFrozenMove] = useState<{
    request: MutationPreviewRequest;
    preview: MutationPreview;
  } | null>(null);

  const isMutating =
    createFolder.isPending || moveFolder.isPending || deleteFolder.isPending;

  function closeManager() {
    if (isMutating || previewMutation.isPending) return;
    setIsOpen(false);
    setError(null);
  }

  async function create() {
    const path = newPath.trim();
    if (!path) {
      setError("New folder path is required.");
      return;
    }
    setError(null);
    try {
      await createFolder.mutateAsync({ params: { path: { path } } });
      setNewPath("");
    } catch (createError) {
      setError(mutationError(createError));
    }
  }

  async function previewMove() {
    const destination = moveDestination.trim();
    if (!moveSource || !destination) {
      setError("Choose a source folder and destination.");
      return;
    }
    const request: MutationPreviewRequest = {
      operation: "move_folder",
      source: moveSource,
      destination,
    };
    setError(null);
    try {
      await beforeMutation?.();
      const preview = await previewMutation.mutateAsync(request);
      setFrozenMove({ request, preview });
    } catch (previewError) {
      setError(mutationError(previewError));
    }
  }

  async function executeMove() {
    if (!frozenMove?.request.destination) return;
    setError(null);
    try {
      await moveFolder.mutateAsync({
        params: { path: { path: frozenMove.request.source } },
        body: { destination: frozenMove.request.destination },
      });
      onMoved?.(frozenMove.request.source, frozenMove.request.destination);
      setFrozenMove(null);
      setMoveSource("");
      setMoveDestination("");
    } catch (moveError) {
      setError(mutationError(moveError));
    }
  }

  function reviewDelete() {
    if (!deleteSource) {
      setError("Choose a folder to delete.");
      return;
    }
    setError(null);
    setDeleteConfirmation("");
    setRecursive(false);
    setDeleteConfirmationOpen(true);
  }

  async function executeDelete() {
    if (!deleteSource || deleteConfirmation !== deleteSource) return;
    setError(null);
    try {
      await beforeMutation?.();
      await deleteFolder.mutateAsync({
        params: {
          path: { path: deleteSource },
          query: { recursive },
        },
      });
      onDeleted?.(deleteSource);
      setDeleteConfirmationOpen(false);
      setDeleteConfirmation("");
      setDeleteSource("");
      setRecursive(false);
    } catch (deleteError) {
      setError(mutationError(deleteError));
    }
  }

  return (
    <>
      <button
        type="button"
        className="cl-mono cursor-pointer text-left text-[10px] uppercase tracking-[0.1em] text-ink-mute hover:text-accent"
        onClick={() => setIsOpen(true)}
      >
        Manage folders
      </button>

      <Dialog
        isOpen={isOpen && !frozenMove && !deleteConfirmationOpen}
        onOpenChange={(open) => {
          if (!open) closeManager();
        }}
        title="Manage folders"
        description="Create folders directly. Moves require a server-generated preview."
        size="lg"
        footer={
          <Button
            variant="secondary"
            onPress={closeManager}
            isDisabled={isMutating}
          >
            Done
          </Button>
        }
      >
        <div className="space-y-5">
          <section
            className="space-y-2"
            aria-labelledby={`${id}-create-folder-heading`}
          >
            <h3
              id={`${id}-create-folder-heading`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Create
            </h3>
            <TextField
              label="New folder path"
              value={newPath}
              onChange={(value) => {
                setNewPath(value);
                setError(null);
              }}
              placeholder="notes/research"
              isDisabled={isMutating}
            />
            <Button
              variant="primary"
              onPress={() => void create()}
              isDisabled={isMutating}
            >
              {createFolder.isPending ? "Creating…" : "Create folder"}
            </Button>
          </section>

          <section
            className="space-y-2 border-t border-border pt-4"
            aria-labelledby={`${id}-move-folder-heading`}
          >
            <h3
              id={`${id}-move-folder-heading`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Move or rename
            </h3>
            <FolderSelect
              id={`${id}-folder-move-source`}
              label="Folder to move"
              value={moveSource}
              paths={paths}
              disabled={isLoading || isMutating}
              onChange={(value) => {
                setMoveSource(value);
                setError(null);
              }}
            />
            <TextField
              label="Folder destination"
              value={moveDestination}
              onChange={(value) => {
                setMoveDestination(value);
                setError(null);
              }}
              placeholder="archive/research"
              isDisabled={isMutating}
            />
            <Button
              variant="primary"
              onPress={() => void previewMove()}
              isDisabled={isMutating || previewMutation.isPending}
            >
              {previewMutation.isPending
                ? "Preparing preview…"
                : "Preview folder move"}
            </Button>
          </section>

          <section
            className="space-y-2 border-t border-border pt-4"
            aria-labelledby={`${id}-delete-folder-heading`}
          >
            <h3
              id={`${id}-delete-folder-heading`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Delete
            </h3>
            <FolderSelect
              id={`${id}-folder-delete-source`}
              label="Folder to delete"
              value={deleteSource}
              paths={paths}
              disabled={isLoading || isMutating}
              onChange={(value) => {
                setDeleteSource(value);
                setError(null);
              }}
            />
            <Button
              variant="danger"
              onPress={reviewDelete}
              isDisabled={isMutating}
            >
              Review folder deletion
            </Button>
          </section>

          {treeError ? (
            <p className="text-xs text-destructive">
              Folder list failed to load: {mutationError(treeError)}
            </p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </Dialog>

      {frozenMove ? (
        <MutationPreviewDialog
          isOpen
          title="Review folder move"
          confirmLabel="Move folder"
          preview={frozenMove.preview}
          isExecuting={moveFolder.isPending}
          error={error}
          onConfirm={() => void executeMove()}
          onCancel={() => {
            if (!moveFolder.isPending) setFrozenMove(null);
          }}
        />
      ) : null}

      <Dialog
        isOpen={deleteConfirmationOpen}
        onOpenChange={(open) => {
          if (!open && !deleteFolder.isPending)
            setDeleteConfirmationOpen(false);
        }}
        title="Delete folder permanently"
        description={`Folder: ${deleteSource}`}
        isDismissable={!deleteFolder.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setDeleteConfirmationOpen(false)}
              isDisabled={deleteFolder.isPending}
            >
              Back
            </Button>
            <Button
              variant="danger"
              onPress={() => void executeDelete()}
              isDisabled={
                deleteFolder.isPending || deleteConfirmation !== deleteSource
              }
            >
              {deleteFolder.isPending
                ? "Deleting permanently…"
                : "Delete folder permanently"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-destructive">
            Folder deletion is permanent: its pages do not enter the Rubbish
            Bin. The backend cannot preview folder deletion, so verify the exact
            folder name before continuing.
          </p>
          <TextField
            label={`Type ${deleteSource} to confirm`}
            value={deleteConfirmation}
            onChange={setDeleteConfirmation}
            isDisabled={deleteFolder.isPending}
            autoFocus
          />
          <Checkbox
            isSelected={recursive}
            onChange={setRecursive}
            isDisabled={deleteFolder.isPending}
            description="Leave unchecked to delete empty folders only."
          >
            Delete contents recursively
          </Checkbox>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </Dialog>
    </>
  );
}
