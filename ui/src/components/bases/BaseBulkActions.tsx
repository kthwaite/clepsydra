import { useState } from "react";
import type { BasePropertyEntry, QueryRow } from "#/api/bases";
import { formatApiError } from "#/api/error";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type {
  BaseBulkAction,
  BaseBulkResult,
  BaseTableBulk,
} from "./base-table-model";
import type { CellValue } from "./cells/types";
import { EditableCell } from "./EditableCell";

export function BaseBulkActions({
  rows,
  properties,
  bulk,
  onComplete,
  onClear,
  onPendingChange,
}: {
  rows: QueryRow[];
  properties: readonly BasePropertyEntry[];
  bulk: BaseTableBulk;
  onComplete(result: BaseBulkResult): void;
  onClear(): void;
  onPendingChange(pending: boolean): void;
}) {
  const [field, setField] = useState("");
  const [value, setValue] = useState<CellValue>(null);
  const [tag, setTag] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<BaseBulkResult>();
  const [error, setError] = useState<string>();
  const choices = properties.filter((property) =>
    ["select", "multi_select", "bool", "relation"].includes(
      property.definition.type,
    ),
  );
  const selected = choices.find((property) => property.key === field);
  const run = async (action: BaseBulkAction) => {
    setPending(true);
    onPendingChange(true);
    setError(undefined);
    try {
      const outcome = await bulk.run(rows, action);
      setResult(outcome);
      setArchiving(false);
      onComplete(outcome);
    } catch (failure) {
      setError(formatApiError(failure, "Bulk action failed."));
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  };
  return (
    <section
      className="space-y-2 rounded-xl bg-sink p-3"
      aria-label="Bulk actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span aria-live="polite" className="text-sm">
          {rows.length} selected (loaded rows only)
        </span>
        <label className="flex items-center gap-2 text-sm">
          Set property
          <select
            aria-label="Bulk property"
            disabled={pending}
            value={field}
            onChange={(event) => {
              setField(event.target.value);
              setValue(null);
            }}
            className={cn("rounded-md bg-ground p-2", FOCUS_RING_NATIVE)}
          >
            <option value="">Choose property</option>
            {choices.map((property) => (
              <option key={property.key} value={property.key}>
                {property.key}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <>
            <div className="min-w-28 rounded-md bg-ground">
              <EditableCell
                key={selected.key}
                value={value}
                definition={selected.definition}
                ariaLabel="Bulk value"
                onCommit={setValue}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={pending}
              onPress={() =>
                void run({
                  kind: "set",
                  key: selected.key,
                  type: selected.definition.type,
                  value,
                })
              }
            >
              Apply value
            </Button>
          </>
        ) : null}
        <input
          type="text"
          aria-label="Tag to add"
          placeholder="Add tag"
          value={tag}
          disabled={pending}
          onChange={(event) => setTag(event.target.value)}
          className={cn(
            "w-32 rounded-md bg-ground px-3 py-2 text-sm",
            FOCUS_RING_NATIVE,
          )}
        />
        <Button
          variant="secondary"
          size="sm"
          isDisabled={pending || !tag.trim()}
          onPress={() => void run({ kind: "tag", tag: tag.trim() })}
        >
          Add tag
        </Button>
        <Button
          variant="danger"
          size="sm"
          isDisabled={pending}
          onPress={() => setArchiving(true)}
        >
          Archive selected…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          isDisabled={pending}
          onPress={onClear}
        >
          Clear selection
        </Button>
      </div>
      {result?.failures.length ? (
        <div role="alert" className="text-sm text-hot">
          <p>
            {result.succeeded.length} succeeded; {result.failures.length}{" "}
            failed. Failed rows remain selected.
          </p>
          <ul>
            {result.failures.map((failure) => (
              <li key={failure.id}>
                {failure.label}: {failure.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-hot">
          {error}
        </p>
      ) : null}
      <Dialog
        isOpen={archiving}
        onOpenChange={(open) => {
          if (!pending) setArchiving(open);
        }}
        title="Archive pages"
        description={`Archive ${rows.length} selected loaded pages? Restore remains available in the Rubbish Bin.`}
        isDismissable={!pending}
        footer={
          <>
            <Button
              variant="secondary"
              isDisabled={pending}
              onPress={() => setArchiving(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              isDisabled={pending}
              onPress={() => void run({ kind: "archive" })}
            >
              {pending ? "Archiving…" : "Confirm archive"}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Inbound links become unresolved. Each page is archived independently;
          any refused pages remain selected.
        </p>
      </Dialog>
    </section>
  );
}
