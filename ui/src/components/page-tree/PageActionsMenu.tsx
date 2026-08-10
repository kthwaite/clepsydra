import { useId, useState } from "react";
import {
  type MutationPreview,
  type MutationPreviewRequest,
  type MutationRewrite,
  usePreviewMutation,
} from "#/api/index";
import { useDeletePage, useMovePage } from "#/api/pages";
import { MutationPreviewDialog } from "#/components/page-tree/MutationPreviewDialog";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";

type PageAction = "move" | "delete";

interface FrozenPagePreview {
  action: PageAction;
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
  onDeleted,
}: {
  path: string;
  beforeMutation?: () => Promise<void>;
  onMoved: (path: string) => void;
  onDeleted: () => void;
}) {
  const rewriteId = useId();
  const previewMutation = usePreviewMutation();
  const movePage = useMovePage();
  const deletePage = useDeletePage();
  const [action, setAction] = useState<PageAction | null>(null);
  const [destination, setDestination] = useState("");
  const [rewrite, setRewrite] = useState<MutationRewrite>("plain_text");
  const [error, setError] = useState<string | null>(null);
  const [frozenPreview, setFrozenPreview] = useState<FrozenPagePreview | null>(
    null,
  );

  const isExecuting = movePage.isPending || deletePage.isPending;

  function openAction(next: PageAction) {
    setAction(next);
    setDestination("");
    setRewrite("plain_text");
    setError(null);
    setFrozenPreview(null);
  }

  function closeAction() {
    if (previewMutation.isPending || isExecuting) return;
    resetAction();
  }

  function resetAction() {
    setAction(null);
    setError(null);
    setFrozenPreview(null);
  }

  async function requestPreview() {
    if (!action) return;
    const request: MutationPreviewRequest =
      action === "move"
        ? {
            operation: "move_page",
            source: path,
            destination: destination.trim(),
          }
        : { operation: "delete_page", source: path, rewrite };

    if (action === "move" && !request.destination) {
      setError("Destination path is required.");
      return;
    }

    setError(null);
    try {
      await beforeMutation?.();
      const preview = await previewMutation.mutateAsync(request);
      setFrozenPreview({ action, request, preview });
    } catch (previewError) {
      setError(mutationError(previewError));
    }
  }

  async function executePreview() {
    if (!frozenPreview) return;
    setError(null);
    try {
      if (frozenPreview.action === "move") {
        const destination = frozenPreview.request.destination;
        if (!destination) return;
        const moved = await movePage.mutateAsync({
          params: { path: { path: frozenPreview.request.source } },
          body: { destination },
        });
        resetAction();
        onMoved(moved.path ?? destination);
        return;
      }

      const frozenRewrite = frozenPreview.request.rewrite ?? "plain_text";
      await deletePage.mutateAsync({
        params: {
          path: { path: frozenPreview.request.source },
          query: { force: true, rewrite: frozenRewrite },
        },
      });
      resetAction();
      onDeleted();
    } catch (mutationFailure) {
      setError(mutationError(mutationFailure));
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
          onClick={() => openAction("delete")}
        >
          Delete page
        </button>
      </div>

      <Dialog
        isOpen={action !== null && frozenPreview === null}
        onOpenChange={(open) => {
          if (!open) closeAction();
        }}
        title={action === "move" ? "Move or rename page" : "Delete page"}
        description={`Current path: ${path}`}
        isDismissable={!previewMutation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={closeAction}
              isDisabled={previewMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={action === "delete" ? "danger" : "primary"}
              onPress={() => void requestPreview()}
              isDisabled={previewMutation.isPending}
            >
              {previewMutation.isPending
                ? "Preparing preview…"
                : action === "move"
                  ? "Preview move"
                  : "Preview deletion"}
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
          <div>
            <label
              htmlFor={rewriteId}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Inbound links
            </label>
            <select
              id={rewriteId}
              value={rewrite}
              onChange={(event) => {
                setRewrite(event.target.value as MutationRewrite);
                setError(null);
              }}
              disabled={previewMutation.isPending}
              className="mt-2 w-full border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="plain_text">Preserve labels as plain text</option>
              <option value="unlink">Remove link markup</option>
              <option value="none">Leave unresolved links unchanged</option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              The preview will show every backlink rewrite before deletion.
            </p>
            {error ? (
              <p className="mt-2 text-xs text-destructive">{error}</p>
            ) : null}
          </div>
        )}
      </Dialog>

      {frozenPreview ? (
        <MutationPreviewDialog
          isOpen
          title={
            frozenPreview.action === "move"
              ? "Review page move"
              : "Review page deletion"
          }
          confirmLabel={
            frozenPreview.action === "move" ? "Move page" : "Confirm delete"
          }
          preview={frozenPreview.preview}
          isExecuting={isExecuting}
          error={error}
          onConfirm={() => void executePreview()}
          onCancel={() => {
            if (!isExecuting) setFrozenPreview(null);
          }}
        />
      ) : null}
    </>
  );
}
