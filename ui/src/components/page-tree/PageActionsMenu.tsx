import { useState } from "react";
import {
  type MutationPreview,
  type MutationPreviewRequest,
  usePreviewMutation,
} from "#/api/index";
import {
  type ArchivedPage,
  fetchWordExport,
  useArchivePage,
  useMovePage,
} from "#/api/pages";
import { MutationPreviewDialog } from "#/components/page-tree/MutationPreviewDialog";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/** A Folio rail action: 13.5px Geist, mute until hovered. */
const RAIL_ACTION = cn(
  "cursor-pointer rounded text-left text-[13.5px] transition-colors",
  FOCUS_RING_NATIVE,
);

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
      <ExportWordAction key={path} path={path} />
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

function ExportWordAction({ path }: { path: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setPending(true);
    setError(null);
    try {
      const { blob, filename } = await fetchWordExport(path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      try {
        anchor.href = url;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
      }
    } catch (failure) {
      setError(mutationError(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          RAIL_ACTION,
          "text-mute hover:text-ink disabled:cursor-wait disabled:opacity-50",
        )}
        title="Downloads the saved page; unsaved changes are not included."
        disabled={pending}
        onClick={() => void download()}
      >
        {pending ? "Exporting to Word…" : "Export to Word (.docx)"}
      </button>
      {error ? (
        <p className="m-0 text-[13px] text-hot" role="alert">
          {error}
        </p>
      ) : null}
    </>
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
        className={cn(RAIL_ACTION, "text-mute hover:text-ink")}
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
              {previewMutation.isPending
                ? "Preparing preview…"
                : "Preview move"}
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
        className={cn(RAIL_ACTION, "text-hot hover:underline")}
        onClick={openArchive}
      >
        Archive page
      </button>

      <Dialog
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) closeArchive();
        }}
        title="Archive page"
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
        <div className="space-y-2 text-[14px]">
          <p>This page will be removed from normal views.</p>
          <p>
            Inbound links remain byte-identical and become unresolved after
            archival.
          </p>
          <p>You can restore this page from the Rubbish Bin.</p>
          {error ? (
            <p className="text-[13px] text-hot" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
