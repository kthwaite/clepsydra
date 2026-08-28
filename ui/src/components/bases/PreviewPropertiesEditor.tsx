import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftPreviewField, DraftProperty } from "./definition-model";
import { moveItem } from "./definition-model";
import { presentationFieldIdentity } from "./local-validation";
import { ReorderHandle, useReorderable } from "./ordered-list";
import { SYSTEM_PROPERTY_FIELDS } from "./PropertiesEditor";

export interface PresentationFieldChoice {
  field: string;
  label: string;
  description?: string;
}

export function presentationFieldChoices(
  properties: readonly DraftProperty[],
): PresentationFieldChoice[] {
  const propertyKeys = new Set(properties.map((property) => property.key));
  const systemKeys = new Set<string>(SYSTEM_PROPERTY_FIELDS);
  return [
    ...SYSTEM_PROPERTY_FIELDS.map((key) => {
      const shadowed = propertyKeys.has(key);
      return {
        field: key,
        label: shadowed ? `System ${key}` : key,
      };
    }),
    ...properties.map(({ key }) => {
      const shadowed = systemKeys.has(key);
      const qualified =
        shadowed || key.startsWith("prop.") || key.startsWith("sys.");
      return {
        field: qualified ? `prop.${key}` : key,
        label: shadowed ? `Property ${key}` : key,
      };
    }),
    {
      field: "body",
      label: "body",
      description: "Read-only Markdown body",
    },
  ];
}

interface PreviewPropertiesEditorProps {
  preview: DraftPreviewField[];
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  onChange(preview: DraftPreviewField[]): void;
  registerFocus: RegisterFocusTarget;
}

const controlClass =
  "mt-1 block w-full border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";
const labelClass =
  "text-xs font-bold uppercase tracking-widest text-muted-foreground";

export function PreviewPropertiesEditor({
  preview,
  properties,
  diagnostics,
  onChange,
  registerFocus,
}: PreviewPropertiesEditorProps) {
  const [fieldToAdd, setFieldToAdd] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState<
    | { kind: "move"; id: string; direction: "up" | "down" }
    | { kind: "field"; id: string }
    | { kind: "label"; id: string }
    | { kind: "selector" }
  >();
  const rowActions = useRef(new Map<string, HTMLLIElement>());
  const fieldSelectors = useRef(new Map<string, HTMLSelectElement>());
  const labelInputs = useRef(new Map<string, HTMLInputElement>());
  const selector = useRef<HTMLSelectElement>(null);
  const choices = useMemo(
    () => presentationFieldChoices(properties),
    [properties],
  );
  const selectedIdentities = useMemo(
    () =>
      new Set(
        preview
          .map(({ field }) => presentationFieldIdentity(field))
          .filter((identity): identity is string => identity !== undefined),
      ),
    [preview],
  );

  useEffect(() => {
    if (!focusRequest) return;
    if (
      focusRequest.kind !== "selector" &&
      !preview.some(({ id }) => id === focusRequest.id)
    )
      return;
    if (focusRequest.kind === "selector") {
      selector.current?.focus();
    } else if (focusRequest.kind === "field") {
      fieldSelectors.current.get(focusRequest.id)?.focus();
    } else if (focusRequest.kind === "label") {
      labelInputs.current.get(focusRequest.id)?.focus();
    } else {
      const actions = rowActions.current.get(focusRequest.id);
      const preferred = actions?.querySelector<HTMLButtonElement>(
        `button[data-preview-move-direction="${focusRequest.direction}"]`,
      );
      const fallbackDirection = focusRequest.direction === "up" ? "down" : "up";
      const fallback = actions?.querySelector<HTMLButtonElement>(
        `button[data-preview-move-direction="${fallbackDirection}"]`,
      );
      const target = preferred?.disabled ? fallback : preferred;
      if (target && !target.disabled) target.focus();
    }
    setFocusRequest(undefined);
  }, [focusRequest, preview]);

  function move(from: number, to: number) {
    const row = preview[from];
    if (!row || to < 0 || to >= preview.length || from === to) return;
    setFocusRequest({
      kind: "move",
      id: row.id,
      direction: to < from ? "up" : "down",
    });
    onChange(moveItem(preview, from, to));
    setAnnouncement(
      `Moved ${row.field} to position ${to + 1} of ${preview.length}.`,
    );
  }

  /** Preview rows carry ids, so a drop maps them back to positions. */
  function dropRow(sourceId: string, targetId: string, edge: string) {
    const from = preview.findIndex((row) => row.id === sourceId);
    const target = preview.findIndex((row) => row.id === targetId);
    if (from < 0 || target < 0 || from === target) return;
    const to = edge === "bottom" && from > target ? target + 1 : target;
    move(from, from < to ? to - 1 : to);
  }

  const addReasonId = `${useId()}-add-reason`;
  const fieldToAddIdentity = presentationFieldIdentity(fieldToAdd);
  const canAddField =
    fieldToAdd.length > 0 &&
    (fieldToAddIdentity === undefined ||
      !selectedIdentities.has(fieldToAddIdentity));

  return (
    <section aria-labelledby="preview-properties-heading">
      <h2
        id="preview-properties-heading"
        className="text-sm font-bold uppercase tracking-widest text-foreground"
      >
        Preview properties
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Choose the fields shown in the default page preview, from top to bottom.
        The Markdown body is read-only.
      </p>

      <ol className="mt-5 border-t border-border">
        {preview.map((row, index) => {
          const fieldPath = `preview[${index}].field`;
          const labelPath = `preview[${index}].label`;
          const rowDiagnostics = diagnostics.filter(
            (diagnostic) =>
              diagnostic.path === fieldPath || diagnostic.path === labelPath,
          );
          const invalid = rowDiagnostics.some(
            (diagnostic) => diagnostic.severity === "error",
          );
          return (
            <PreviewRow
              key={row.id}
              id={row.id}
              label={row.field}
              index={index}
              count={preview.length}
              onMove={move}
              onReorder={dropRow}
              onRowRef={(element) => {
                if (element) rowActions.current.set(row.id, element);
                else rowActions.current.delete(row.id);
              }}
            >
              <label className={labelClass}>
                Property {index + 1}
                <select
                  ref={(element) => {
                    registerFocus(fieldPath, element);
                    if (element) fieldSelectors.current.set(row.id, element);
                    else fieldSelectors.current.delete(row.id);
                  }}
                  className={controlClass}
                  value={row.field}
                  aria-label={`Field for preview property ${row.field}`}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => {
                    const field = event.target.value;
                    if (field === row.field) return;
                    const identity = presentationFieldIdentity(field);
                    if (
                      identity !== undefined &&
                      preview.some(
                        (current) =>
                          current.id !== row.id &&
                          presentationFieldIdentity(current.field) === identity,
                      )
                    ) {
                      return;
                    }
                    setFocusRequest({ kind: "field", id: row.id });
                    onChange(
                      preview.map((current) =>
                        current.id === row.id ? { ...current, field } : current,
                      ),
                    );
                  }}
                >
                  {choices.some(
                    (choice) => choice.field === row.field,
                  ) ? null : (
                    <option value={row.field}>{row.field}</option>
                  )}
                  {choices.map((choice) => {
                    const identity = presentationFieldIdentity(choice.field);
                    const selectedElsewhere =
                      identity !== undefined &&
                      preview.some(
                        (current) =>
                          current.id !== row.id &&
                          presentationFieldIdentity(current.field) === identity,
                      );
                    const description = [
                      choice.description,
                      selectedElsewhere ? "Already added" : undefined,
                    ]
                      .filter(Boolean)
                      .join(" — ");
                    return (
                      <option
                        key={choice.field}
                        value={choice.field}
                        disabled={selectedElsewhere}
                      >
                        {choice.label}
                        {description ? ` — ${description}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className={labelClass}>
                Label for {row.field}
                <input
                  ref={(element) => {
                    registerFocus(labelPath, element);
                    if (element) labelInputs.current.set(row.id, element);
                    else labelInputs.current.delete(row.id);
                  }}
                  className={controlClass}
                  value={row.label ?? ""}
                  placeholder="Use the field name"
                  aria-invalid={invalid || undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    onChange(
                      preview.map((current) => {
                        if (current.id !== row.id) return current;
                        if (value.length > 0)
                          return { ...current, label: value };
                        const { label: _label, ...withoutLabel } = current;
                        return withoutLabel;
                      }),
                    );
                  }}
                />
              </label>
              <div className="flex flex-wrap justify-end gap-1">
                <Button
                  data-preview-move-direction="up"
                  size="sm"
                  variant="ghost"
                  isDisabled={index === 0}
                  onPress={() => move(index, index - 1)}
                >
                  Move {row.field} up
                </Button>
                <Button
                  data-preview-move-direction="down"
                  size="sm"
                  variant="ghost"
                  isDisabled={index === preview.length - 1}
                  onPress={() => move(index, index + 1)}
                >
                  Move {row.field} down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    const remaining = preview.filter(
                      (current) => current.id !== row.id,
                    );
                    const next =
                      remaining[Math.min(index, remaining.length - 1)];
                    setFocusRequest(
                      next
                        ? { kind: "label", id: next.id }
                        : { kind: "selector" },
                    );
                    onChange(remaining);
                  }}
                >
                  Remove preview property {row.field}
                </Button>
              </div>
              {rowDiagnostics.length > 0 ? (
                <p
                  className={
                    invalid
                      ? "text-xs text-destructive sm:col-span-3"
                      : "text-xs text-warn sm:col-span-3"
                  }
                >
                  {rowDiagnostics.map(({ message }) => message).join(" ")}
                </p>
              ) : null}
            </PreviewRow>
          );
        })}
      </ol>

      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
      <div className="mt-4 grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className={labelClass}>
          Preview property to add
          <select
            ref={selector}
            className={controlClass}
            value={fieldToAdd}
            onChange={(event) => setFieldToAdd(event.target.value)}
          >
            <option value="">Choose a property</option>
            {choices.map((choice) => {
              const identity = presentationFieldIdentity(choice.field);
              const selected =
                identity !== undefined && selectedIdentities.has(identity);
              const description = [
                choice.description,
                selected ? "Already added" : undefined,
              ]
                .filter(Boolean)
                .join(" — ");
              return (
                <option
                  key={choice.field}
                  value={choice.field}
                  disabled={selected}
                >
                  {choice.label}
                  {description ? ` — ${description}` : ""}
                </option>
              );
            })}
          </select>
        </label>
        <Button
          variant="primary"
          isDisabled={!canAddField}
          aria-describedby={canAddField ? undefined : addReasonId}
          onPress={() => {
            if (!canAddField) return;
            const added = {
              id: crypto.randomUUID(),
              field: fieldToAdd,
            };
            setFocusRequest({ kind: "label", id: added.id });
            onChange([...preview, added]);
            setFieldToAdd("");
          }}
        >
          Add preview property
        </Button>
        {canAddField ? null : (
          <span id={addReasonId} className="sr-only">
            {fieldToAdd.length === 0
              ? "Choose a field to add"
              : "That field is already a preview property"}
          </span>
        )}
      </div>
    </section>
  );
}

/** A preview-property row with the shared reorder grip. Its move buttons stay
 * as they are: they carry this editor's own focus-restoration contract. */
function PreviewRow({
  id,
  label,
  index,
  count,
  onMove,
  onReorder,
  onRowRef,
  children,
}: {
  id: string;
  label: string;
  index: number;
  count: number;
  onMove(from: number, to: number): void;
  onReorder(sourceId: string, targetId: string, edge: string): void;
  onRowRef(element: HTMLLIElement | null): void;
  children: ReactNode;
}) {
  const { rowRef, setHandle, onHandleKeyDown } = useReorderable<HTMLLIElement>({
    kind: "base-preview-property",
    idKey: "previewId",
    id,
    index,
    count,
    onMove,
    onReorder,
  });

  return (
    <li
      ref={(element) => {
        rowRef.current = element;
        onRowRef(element);
      }}
      className="grid gap-3 border-b border-border py-3 sm:grid-cols-[auto_minmax(8rem,0.7fr)_minmax(10rem,1fr)_auto] sm:items-end"
    >
      <ReorderHandle
        label={label}
        setHandle={setHandle}
        onKeyDown={onHandleKeyDown}
      />
      {children}
    </li>
  );
}
