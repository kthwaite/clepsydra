import { useState } from "react";
import type { QueryRow } from "#/api/bases";
import { formatApiError } from "#/api/error";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

export function SaveRowTemplateDialog({
  row,
  onClose,
  onSave,
}: {
  row: QueryRow;
  onClose(): void;
  onSave(row: QueryRow, name: string, includeBody: boolean): Promise<void>;
}) {
  const [name, setName] = useState(row.title ?? "");
  const [includeBody, setIncludeBody] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onSave(row, name, includeBody);
      onClose();
    } catch (failure) {
      setError(formatApiError(failure, "The template could not be saved."));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title="Save as template"
      description="Capture this row's declared properties for new members. Existing pages are unchanged."
      isDismissable={!pending}
      footer={
        <>
          <Button variant="secondary" isDisabled={pending} onPress={onClose}>
            Cancel
          </Button>
          <Button
            isDisabled={pending || !name.trim()}
            onPress={() => void save()}
          >
            {pending ? "Saving…" : "Save template"}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-2 text-sm">
        Template name
        <input
          disabled={pending}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={cn("rounded-md bg-sink px-3 py-2", FOCUS_RING_NATIVE)}
        />
      </label>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          className={cn("accent-accent", FOCUS_RING_NATIVE)}
          disabled={pending}
          type="checkbox"
          checked={includeBody}
          onChange={(event) => setIncludeBody(event.target.checked)}
        />
        Include page body
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-hot">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
