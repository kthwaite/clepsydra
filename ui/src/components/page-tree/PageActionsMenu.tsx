import { useState } from "react";
import {
  type MutationPreview,
  type MutationPreviewRequest,
  usePreviewMutation,
} from "#/api/index";
import {
  type ArchivedPage,
  useArchivePage,
  useMovePage,
} from "#/api/pages";
import { MutationPreviewDialog } from "#/components/page-tree/MutationPreviewDialog";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";

interface FrozenMovePreview {
  request: MutationPreviewRequest;
  preview: MutationPreview;
}

interface PageMutationProps {
  path: string;
  beforeMutation?: () => Promise<void>;
}

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

export function PageActionsMenu({
  path,
  beforeMutation,
  onMoved,
  onArchived,
  archiveOnly = false,
}: PageMutationProps & {
  onMoved: (path: string) => void;
  onArchived: (archived: ArchivedPage) => void;
  archiveOnly?: boolean;
}) {
  return (
    <div className="grid gap-1">
      {archiveOnly ? null : (
        <MovePageAction
          path={path}
          beforeMutation={beforeMutation}
          onMoved={onMoved}
        />
      )}
      <ArchivePageAction
        path={path}
        beforeMutation={beforeMutation}
        onArchived={onArchived}
      />
    </div>
  );
}

function MovePageAction({
  path,
  beforeMutation,
  onMoved,
}: PageMutationProps & { onMoved: (path: string) => void }) {
  const previewMutation = usePreviewMutation();
  const movePage = useMovePage();
  const [isOpen, setIsOpen] = useState(false);
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [frozenMove, setFrozenMove] = useState<FrozenMovePreview | null>(null);

  function openMove() {
    setDestination("");
    setError(null);
    setFrozenMove(null);
    setIsOpen(true);
  }

  function resetMove() {
    setIsOpen(false);
    setError(null);
    setFrozenMove(null);
  }

  function closeMove() {
    if (previewMutation.isPending || movePage.isPending) return;
    resetMove();
  }

  async function requestMovePreview() {
    const request: MutationPreviewRequest = {
      operation: "move_page",
      source: path,
      destination: destination.trim(),
    };
    if (!request.destination) {
      setError("Destination path is required.");
      return;
    }

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
    if (!frozenMove) return;
    const destination = frozenMove.request.destination;

    setError(null);
    try {
      const moved = await movePage.mutateAsync({
        params: { path: { path: frozenMove.request.source } },
        body: { destination },
      });
      resetMove();
      onMoved(moved.path ?? destination);
    } catch (mutationFailure) {
      setError(mutationError(mutationFailure));
    }
  }

  return (
    <>
      <button
        type="button"
        className="cl-mono cursor-pointer text-left text-[10px] uppercase tracking-[0.1em] text-ink-mute hover:text-accent"
        onClick={openMove}
      >
        Move or rename page
      </button>

      <Dialog
        isOpen={isOpen && frozenMove === null}
        onOpenChange={(open) => {
          if (!open) closeMove();
        }}
        title="Move or rename page"
        description={`Current path: ${path}`}
        isDismissable={!previewMutation.isPending && !movePage.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={closeMove}
              isDisabled={previewMutation.isPending || movePage.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={() => void requestMovePreview()}
              isDisabled={previewMutation.isPending || movePage.isPending}
            >
              {previewMutation.isPending ? "Preparing preview…" : "Preview move"}
            </Button>
          </>
        }
      >
        <TextField
          label="Destination path"
          value={destination}
          onChange={(value) => {
            setDestination(value);
            setError(null);
          }}
          placeholder="archive/new-name.md"
          description="Enter the complete vault-relative path, including .md."
          isDisabled={previewMutation.isPending}
          isInvalid={!!error}
          errorMessage={error ?? undefined}
          autoFocus
        />
      </Dialog>

      {frozenMove ? (
        <MutationPreviewDialog
          isOpen
          title="Review page move"
          confirmLabel="Move page"
          preview={frozenMove.preview}
          isExecuting={movePage.isPending}
          error={error}
          onConfirm={() => void executeMove()}
          onCancel={() => {
            if (!movePage.isPending) setFrozenMove(null);
          }}
        />
      ) : null}
    </>
  );
}

function ArchivePageAction({
  path,
  beforeMutation,
  onArchived,
}: PageMutationProps & {
  onArchived: (archived: ArchivedPage) => void;
}) {
  const archivePage = useArchivePage();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openArchive() {
    setError(null);
    setIsOpen(true);
  }

  function closeArchive() {
    if (archivePage.isPending) return;
    setIsOpen(false);
    setError(null);
  }

  async function executeArchive() {
    setError(null);
    try {
      await beforeMutation?.();
      const archived = await archivePage.mutateAsync({
        params: { path: { path } },
      });
      setIsOpen(false);
      onArchived(archived);
    } catch (archiveFailure) {
      setError(mutationError(archiveFailure));
    }
  }

  return (
    <>
      <button
        type="button"
        className="cl-mono cursor-pointer text-left text-[10px] uppercase tracking-[0.1em] text-destructive hover:underline"
        onClick={openArchive}
      >
        Archive Page
      </button>

      <Dialog
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) closeArchive();
        }}
        title="Archive Page"
        description={`Current path: ${path}`}
        isDismissable={!archivePage.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={closeArchive}
              isDisabled={archivePage.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onPress={() => void executeArchive()}
              isDisabled={archivePage.isPending}
            >
              {archivePage.isPending ? "Archiving…" : "Confirm archive"}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p>This page will be removed from normal views.</p>
          <p>
            Inbound links remain byte-identical and become unresolved after
            archival.
          </p>
          <p>You can restore this page from the Rubbish Bin.</p>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
