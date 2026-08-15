import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type {
  DraftPreviewField,
  DraftProperty,
} from "./definition-model";
import { moveItem } from "./definition-model";
import { presentationFieldIdentity } from "./local-validation";
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
    | { kind: "label"; id: string }
    | { kind: "selector" }
  >();
  const rowActions = useRef(new Map<string, HTMLLIElement>());
  const labelInputs = useRef(new Map<string, HTMLInputElement>());
  const selector = useRef<HTMLSelectElement>(null);
  const choices = useMemo(() => presentationFieldChoices(properties), [properties]);
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
    if (focusRequest.kind === "selector") {
      selector.current?.focus();
    } else if (focusRequest.kind === "label") {
      labelInputs.current.get(focusRequest.id)?.focus();
    } else {
      const actions = rowActions.current.get(focusRequest.id);
      const preferred = actions?.querySelector<HTMLButtonElement>(
        `button[data-preview-move-direction="${focusRequest.direction}"]`,
      );
      const fallbackDirection =
        focusRequest.direction === "up" ? "down" : "up";
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
            <li
              key={row.id}
              ref={(element) => {
                if (element) rowActions.current.set(row.id, element);
                else rowActions.current.delete(row.id);
              }}
              className="grid gap-3 border-b border-border py-3 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(10rem,1fr)_auto] sm:items-end"
            >
              <div>
                <span className={labelClass}>Property {index + 1}</span>
                <span
                  ref={(element) => registerFocus(fieldPath, element)}
                  tabIndex={-1}
                  className="mt-1 block border border-border bg-muted/30 px-3 py-2 font-mono text-sm text-foreground outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  {row.field}
                </span>
              </div>
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
                        if (value.length > 0) return { ...current, label: value };
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
                    const next = remaining[Math.min(index, remaining.length - 1)];
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
            </li>
          );
        })}
      </ol>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
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
          size="sm"
          variant="secondary"
          isDisabled={!fieldToAdd}
          onPress={() => {
            if (!fieldToAdd) return;
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
      </div>
    </section>
  );
}
