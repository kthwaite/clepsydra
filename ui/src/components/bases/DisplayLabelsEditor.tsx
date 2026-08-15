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
  const [focusSelector, setFocusSelector] = useState(false);
  const selector = useRef<HTMLSelectElement>(null);
  const choices = useMemo(() => presentationFieldChoices(properties), [properties]);

  useEffect(() => {
    if (!focusSelector) return;
    selector.current?.focus();
    setFocusSelector(false);
  }, [focusSelector, labels]);

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
          return (
            <li
              key={field}
              className="grid items-end gap-2 border-b border-border pb-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <label className={labelClass}>
                Display label for {field}
                <input
                  ref={(element) => registerFocus(path, element)}
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
                  setFocusSelector(true);
                  onChange(remaining);
                }}
              >
                Reset label {field}
              </Button>
              {fieldDiagnostics.length > 0 ? (
                <p
                  className={
                    invalid
                      ? "text-xs text-destructive sm:col-span-2"
                      : "text-xs text-warn sm:col-span-2"
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
              const labelled = Object.hasOwn(labels, choice.field);
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
          isDisabled={!fieldToAdd}
          onPress={() => {
            const choice = choices.find(({ field }) => field === fieldToAdd);
            if (!choice) return;
            onChange({ ...labels, [fieldToAdd]: defaultLabel(choice) });
            setFieldToAdd("");
          }}
        >
          Add label
        </Button>
      </div>
    </section>
  );
}
