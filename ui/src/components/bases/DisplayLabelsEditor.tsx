import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty, DraftView } from "./definition-model";
import { presentationFieldIdentity } from "./local-validation";
import {
  type PresentationFieldChoice,
  presentationFieldChoices,
} from "./PreviewPropertiesEditor";

interface DisplayLabelsEditorProps {
  labels: DraftView["labels"];
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  diagnosticRoot: string;
  onChange(labels: DraftView["labels"]): void;
  registerFocus: RegisterFocusTarget;
}

const controlClass = cn(
  "block h-10 w-full min-w-0 rounded-full bg-sink px-4 text-[14px] text-ink aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-hot",
  FOCUS_RING_NATIVE,
);
const labelClass = "block min-w-0 text-[12.5px] text-mute";

const selectClass = cn(controlClass, "appearance-none truncate pr-10");

/** Dresses a native select as the Stone & Lamp select pill. Native options
 * stay because each carries a disabled "Already labelled" state. */
function SelectShell({ children }: { children: ReactNode }) {
  return (
    <span className="relative mt-1.5 block">
      {children}
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-mute"
      />
    </span>
  );
}

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
    if (
      focusRequest.kind !== "selector" &&
      !Object.hasOwn(labels, focusRequest.field)
    )
      return;
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
      className="flex min-w-0 flex-col gap-2.5"
      aria-labelledby={`${diagnosticRoot}-heading`}
    >
      <h4
        id={`${diagnosticRoot}-heading`}
        className="flex items-center gap-2.5 font-serif text-[19px] italic leading-none text-ink"
      >
        <Tick variant="faint" />
        Display labels
      </h4>
      <div className="min-w-0 pl-[17px]">
        <p className="text-[13px] leading-normal text-mute">
          Override field names in this view. Labels may target fields outside
          the visible columns; the Markdown body is read-only.
        </p>

        <ol className="mt-2.5 flex flex-col gap-3 empty:hidden">
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
                className="grid shrink-0 items-start gap-x-2 gap-y-1.5 sm:grid-cols-[minmax(7rem,0.8fr)_minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <label className={labelClass}>
                    Field
                    <SelectShell>
                      <select
                        className={selectClass}
                        ref={(element) => {
                          if (element)
                            fieldSelectors.current.set(field, element);
                          else fieldSelectors.current.delete(field);
                        }}
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
                          const identity = presentationFieldIdentity(
                            choice.field,
                          );
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
                    </SelectShell>
                  </label>
                  <span
                    role="note"
                    aria-label={`Stored label key ${field}`}
                    title={field}
                    className="mt-1.5 block truncate px-4 text-[12.5px] text-mute"
                  >
                    Stored as {field}
                  </span>
                </div>
                <label className={labelClass}>
                  Display label<span className="sr-only"> for {field}</span>
                  <input
                    ref={(element) => {
                      registerFocus(path, element);
                      if (element) labelInputs.current.set(field, element);
                      else labelInputs.current.delete(field);
                    }}
                    className={cn(controlClass, "mt-1.5")}
                    value={label}
                    aria-invalid={invalid || undefined}
                    onChange={(event) =>
                      onChange({ ...labels, [field]: event.target.value })
                    }
                  />
                </label>
                <Button
                  className="justify-self-start sm:mt-[29px]"
                  size="sm"
                  variant="ghost"
                  aria-label={`Reset label ${field}`}
                  onPress={() => {
                    const { [field]: _removed, ...remaining } = labels;
                    setFocusRequest({ kind: "selector" });
                    onChange(remaining);
                  }}
                >
                  Reset
                </Button>
                {fieldDiagnostics.length > 0 ? (
                  <p
                    className={
                      invalid
                        ? "text-[12.5px] text-hot sm:col-span-3"
                        : "text-[12.5px] text-warn sm:col-span-3"
                    }
                  >
                    {fieldDiagnostics.map(({ message }) => message).join(" ")}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>

        <div className="mt-2.5 grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className={labelClass}>
            Field to label
            <SelectShell>
              <select
                ref={selector}
                className={selectClass}
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
            </SelectShell>
          </label>
          <Button
            className="mb-1"
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
      </div>
    </section>
  );
}
