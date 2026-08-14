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

type PageAction = "move" | "archive";

interface FrozenMovePreview {
  request: MutationPreviewRequest;
  preview: MutationPreview;
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
}: {
  path: string;
  beforeMutation?: () => Promise<void>;
  onMoved: (path: string) => void;
  onArchived: (archived: ArchivedPage) => void;
}) {
  const previewMutation = usePreviewMutation();
  const movePage = useMovePage();
  const archivePage = useArchivePage();
  const [action, setAction] = useState<PageAction | null>(null);
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [frozenMove, setFrozenMove] = useState<FrozenMovePreview | null>(null);

  const isExecuting = movePage.isPending || archivePage.isPending;

  function openAction(next: PageAction) {
    setAction(next);
    setDestination("");
    setError(null);
    setFrozenMove(null);
  }

  function closeAction() {
    if (previewMutation.isPending || isExecuting) return;
    resetAction();
  }

  function resetAction() {
    setAction(null);
    setError(null);
    setFrozenMove(null);
  }

  async function requestMovePreview() {
    if (action !== "move") return;
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
    if (!destination) return;

    setError(null);
    try {
      const moved = await movePage.mutateAsync({
        params: { path: { path: frozenMove.request.source } },
        body: { destination },
      });
      resetAction();
      onMoved(moved.path ?? destination);
    } catch (mutationFailure) {
      setError(mutationError(mutationFailure));
    }
  }

  async function executeArchive() {
    if (action !== "archive") return;

    setError(null);
    try {
      await beforeMutation?.();
      const archived = await archivePage.mutateAsync({
        params: { path: { path } },
      });
      resetAction();
      onArchived(archived);
    } catch (archiveFailure) {
      setError(mutationError(archiveFailure));
    }
  }

  return (
    <>
      <div className="grid gap-1">
        <button
          type="button"
          className="cl-mono cursor-pointer text-left text-[10px] uppercase tracking-[0.1em] text-ink-mute hover:text-accent"
          onClick={() => openAction("move")}
        >
          Move or rename page
        </button>
        <button
          type="button"
          className="cl-mono cursor-pointer text-left text-[10px] uppercase tracking-[0.1em] text-destructive hover:underline"
          onClick={() => openAction("archive")}
        >
          Archive Page
        </button>
      </div>

      <Dialog
        isOpen={action !== null && frozenMove === null}
        onOpenChange={(open) => {
          if (!open) closeAction();
        }}
        title={action === "move" ? "Move or rename page" : "Archive Page"}
        description={`Current path: ${path}`}
        isDismissable={!previewMutation.isPending && !isExecuting}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={closeAction}
              isDisabled={previewMutation.isPending || isExecuting}
            >
              Cancel
            </Button>
            <Button
              variant={action === "archive" ? "danger" : "primary"}
              onPress={() =>
                void (action === "move"
                  ? requestMovePreview()
                  : executeArchive())
              }
              isDisabled={previewMutation.isPending || isExecuting}
            >
              {action === "move"
                ? previewMutation.isPending
                  ? "Preparing preview…"
                  : "Preview move"
                : archivePage.isPending
                  ? "Archiving…"
                  : "Confirm archive"}
            </Button>
          </>
        }
      >
        {action === "move" ? (
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
        ) : (
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
        )}
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
