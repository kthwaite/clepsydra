import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty, DraftView } from "./definition-model";
import {
  presentationFieldChoices,
  type PresentationFieldChoice,
} from "./PreviewPropertiesEditor";
import { presentationFieldIdentity } from "./local-validation";

interface DisplayLabelsEditorProps {
  labels: DraftView["labels"];
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  diagnosticRoot: string;
  onChange(labels: DraftView["labels"]): void;
  registerFocus: RegisterFocusTarget;
}

const controlClass =
  "mt-1 block w-full border border-input bg-background px-3 py-2 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";
const labelClass =
  "text-xs font-bold uppercase tracking-widest text-muted-foreground";

function defaultLabel(choice: PresentationFieldChoice): string {
  const readable = choice.label.replaceAll("_", " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

export function DisplayLabelsEditor({
  labels,
  properties,
  diagnostics,
  diagnosticRoot,
  onChange,
  registerFocus,
}: DisplayLabelsEditorProps) {
  const [fieldToAdd, setFieldToAdd] = useState("");
  const [focusRequest, setFocusRequest] = useState<
    | { kind: "field"; field: string }
    | { kind: "label"; field: string }
    | { kind: "selector" }
  >();
  const fieldSelectors = useRef(new Map<string, HTMLSelectElement>());
  const labelInputs = useRef(new Map<string, HTMLInputElement>());
  const selector = useRef<HTMLSelectElement>(null);
  const choices = useMemo(
    () => presentationFieldChoices(properties),
    [properties],
  );
  const labelledIdentities = useMemo(
    () =>
      new Set(
        Object.keys(labels)
          .map((field) => presentationFieldIdentity(field))
          .filter((identity): identity is string => identity !== undefined),
      ),
    [labels],
  );

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.kind === "field") {
      fieldSelectors.current.get(focusRequest.field)?.focus();
    } else if (focusRequest.kind === "label") {
      labelInputs.current.get(focusRequest.field)?.focus();
    } else {
      selector.current?.focus();
    }
    setFocusRequest(undefined);
  }, [focusRequest, labels]);

  const choiceToAdd = choices.find(({ field }) => field === fieldToAdd);
  const fieldToAddIdentity =
    choiceToAdd === undefined
      ? undefined
      : presentationFieldIdentity(choiceToAdd.field);
  const canAddLabel =
    choiceToAdd !== undefined &&
    (fieldToAddIdentity === undefined ||
      !labelledIdentities.has(fieldToAddIdentity));

  return (
    <section
      className="mt-6 border-t border-border pt-4"
      aria-labelledby={`${diagnosticRoot}-heading`}
    >
      <h4
        id={`${diagnosticRoot}-heading`}
        className="font-mono text-xs font-semibold uppercase tracking-widest text-foreground"
      >
        Display labels
      </h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Override field names in this view. Labels may target fields outside the
        visible columns; the Markdown body is read-only.
      </p>

      <ol className="mt-3 grid gap-2">
        {Object.entries(labels).map(([field, label]) => {
          const path = `${diagnosticRoot}.${field}`;
          const fieldDiagnostics = diagnostics.filter(
            (diagnostic) => diagnostic.path === path,
          );
          const invalid = fieldDiagnostics.some(
            (diagnostic) => diagnostic.severity === "error",
          );
          const identitiesUsedByOtherRows = new Set(
            Object.keys(labels)
              .filter((existingField) => existingField !== field)
              .map((existingField) =>
                presentationFieldIdentity(existingField),
              )
              .filter(
                (identity): identity is string => identity !== undefined,
              ),
          );
          return (
            <li
              key={field}
              className="grid items-end gap-2 border-b border-border pb-3 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(8rem,0.7fr)_minmax(10rem,1fr)_auto]"
            >
              <label className={labelClass}>
                Field
                <select
                  ref={(element) => {
                    if (element) fieldSelectors.current.set(field, element);
                    else fieldSelectors.current.delete(field);
                  }}
                  className={controlClass}
                  value={field}
                  aria-label={`Field for display label ${field}`}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => {
                    const nextField = event.target.value;
                    if (nextField === field) return;
                    const identity = presentationFieldIdentity(nextField);
                    if (
                      identity !== undefined &&
                      identitiesUsedByOtherRows.has(identity)
                    ) {
                      return;
                    }
                    const { [field]: movedLabel, ...remaining } = labels;
                    setFocusRequest({ kind: "field", field: nextField });
                    onChange({ ...remaining, [nextField]: movedLabel });
                  }}
                >
                  {choices.some(
                    (choice) => choice.field === field,
                  ) ? null : (
                    <option value={field}>{field}</option>
                  )}
                  {choices.map((choice) => {
                    const identity = presentationFieldIdentity(choice.field);
                    const labelled =
                      identity !== undefined &&
                      identitiesUsedByOtherRows.has(identity);
                    const description = [
                      choice.description,
                      labelled ? "Already labelled" : undefined,
                    ]
                      .filter(Boolean)
                      .join(" — ");
                    return (
                      <option
                        key={choice.field}
                        value={choice.field}
                        disabled={labelled}
                      >
                        {choice.label}
                        {description ? ` — ${description}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div>
                <span className={labelClass}>Stored key</span>
                <span
                  aria-label={`Stored label key ${field}`}
                  className="mt-1 block border border-border bg-muted/30 px-3 py-2 font-mono text-sm text-foreground"
                >
                  {field}
                </span>
              </div>
              <label className={labelClass}>
                Display label for {field}
                <input
                  ref={(element) => {
                    registerFocus(path, element);
                    if (element) labelInputs.current.set(field, element);
                    else labelInputs.current.delete(field);
                  }}
                  className={controlClass}
                  value={label}
                  aria-invalid={invalid || undefined}
                  onChange={(event) =>
                    onChange({ ...labels, [field]: event.target.value })
                  }
                />
              </label>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => {
                  const { [field]: _removed, ...remaining } = labels;
                  setFocusRequest({ kind: "selector" });
                  onChange(remaining);
                }}
              >
                Reset label {field}
              </Button>
              {fieldDiagnostics.length > 0 ? (
                <p
                  className={
                    invalid
                      ? "text-xs text-destructive sm:col-span-4"
                      : "text-xs text-warn sm:col-span-4"
                  }
                >
                  {fieldDiagnostics.map(({ message }) => message).join(" ")}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="mt-3 grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className={labelClass}>
          Field to label
          <select
            ref={selector}
            className={controlClass}
            value={fieldToAdd}
            onChange={(event) => setFieldToAdd(event.target.value)}
          >
            <option value="">Choose a field</option>
            {choices.map((choice) => {
              const identity = presentationFieldIdentity(choice.field);
              const labelled =
                identity !== undefined && labelledIdentities.has(identity);
              const description = [
                choice.description,
                labelled ? "Already labelled" : undefined,
              ]
                .filter(Boolean)
                .join(" — ");
              return (
                <option
                  key={choice.field}
                  value={choice.field}
                  disabled={labelled}
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
          isDisabled={!canAddLabel}
          onPress={() => {
            if (!canAddLabel || choiceToAdd === undefined) return;
            setFocusRequest({ kind: "label", field: fieldToAdd });
            onChange({
              ...labels,
              [fieldToAdd]: defaultLabel(choiceToAdd),
            });
            setFieldToAdd("");
          }}
        >
          Add label
        </Button>
      </div>
    </section>
  );
}
