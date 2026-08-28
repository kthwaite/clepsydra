import { useState } from "react";
import type { QueryRow } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";

export interface ArchiveRowDialogProps {
  row: QueryRow | null;
  onCancel(): void;
  onConfirm(row: QueryRow): Promise<void>;
}

/** Confirms archiving one row's page, in the words `PageActionsMenu` uses. */
export function ArchiveRowDialog({
  row,
  onCancel,
  onConfirm,
}: ArchiveRowDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (pending) return;
    setError(null);
    onCancel();
  };
  const confirm = async () => {
    if (!row) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(row);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The page could not be archived.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      isOpen={row !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Archive page"
      description={row ? (row.title ?? row.path) : ""}
      isDismissable={!pending}
      footer={
        <>
          <Button variant="secondary" onPress={close} isDisabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onPress={() => void confirm()}
            isDisabled={pending}
          >
            {pending ? "Archiving…" : "Confirm archive"}
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
  );
}
