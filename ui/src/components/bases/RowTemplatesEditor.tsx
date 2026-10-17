import { useState } from "react";
import type { PropertyDefinition } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { RegisterFocusTarget } from "./BaseDefinitionWorkspace";
import { DefinitionSectionHeading } from "./DefinitionHeader";
import type { BaseDraft } from "./definition-model";
import { EditableCell } from "./EditableCell";
import { presentationFieldIdentity } from "./local-validation";

type RowTemplate = NonNullable<BaseDraft["templates"]>[number];
const SYSTEM_TEMPLATE_FIELDS: Record<string, PropertyDefinition> = {
  title: { type: "text" },
  kind: { type: "text" },
  project: { type: "text" },
  tags: { type: "multi_select" },
  aliases: { type: "multi_select" },
};
const INPUT = cn(
  "block w-full rounded-lg bg-sink p-2 text-sm text-ink",
  FOCUS_RING_NATIVE,
);

function TemplateEditor({
  template,
  index,
  properties,
  onChange,
  onRemove,
  registerFocus,
}: {
  template: RowTemplate;
  index: number;
  properties: BaseDraft["properties"];
  onChange(template: RowTemplate): void;
  onRemove(): void;
  registerFocus: RegisterFocusTarget;
}) {
  const [newField, setNewField] = useState("");
  const definitions = new Map(Object.entries(SYSTEM_TEMPLATE_FIELDS));
  for (const property of properties) {
    definitions.set(`prop.${property.key}`, property.definition);
    if (!Object.hasOwn(SYSTEM_TEMPLATE_FIELDS, property.key))
      definitions.set(property.key, property.definition);
  }
  const available = [
    ...Object.keys(SYSTEM_TEMPLATE_FIELDS),
    ...properties.map(({ key }) =>
      presentationFieldIdentity(key) === `property:${key}`
        ? key
        : `prop.${key}`,
    ),
  ].filter(
    (key) =>
      !Object.keys(template.fields).some(
        (existing) =>
          presentationFieldIdentity(existing) ===
          presentationFieldIdentity(key),
      ),
  );
  return (
    <fieldset className="grid gap-3 rounded-xl bg-raise p-4">
      <legend className="px-2 text-sm">Row template {index + 1}</legend>
      <label className="text-sm text-mute">
        Template name
        <input
          aria-label={`Template ${index + 1} name`}
          ref={(node) => registerFocus(`templates[${index}].name`, node)}
          className={INPUT}
          value={template.name}
          onChange={(event) =>
            onChange({ ...template, name: event.target.value })
          }
        />
      </label>
      {Object.entries(template.fields).map(([field, value]) => {
        const definition = field.startsWith("sys.")
          ? Object.hasOwn(SYSTEM_TEMPLATE_FIELDS, field.slice(4))
            ? SYSTEM_TEMPLATE_FIELDS[field.slice(4)]
            : undefined
          : definitions.get(field);
        return (
          <div
            key={field}
            tabIndex={-1}
            className="grid gap-1"
            ref={(node) =>
              registerFocus(`templates[${index}].fields.${field}`, node)
            }
          >
            <span
              className="text-sm text-mute"
              title={definition?.description ?? undefined}
            >
              {field}
            </span>
            {definition ? (
              <EditableCell
                ariaLabel={`${template.name || `Template ${index + 1}`} — ${field}`}
                commitOnBlur
                definition={definition}
                value={
                  typeof value === "string" ||
                  typeof value === "number" ||
                  typeof value === "boolean" ||
                  (Array.isArray(value) &&
                    value.every((item) => typeof item === "string"))
                    ? value
                    : null
                }
                onCommit={(next) => {
                  const fields = { ...template.fields };
                  if (next === null) delete fields[field];
                  else fields[field] = next;
                  onChange({ ...template, fields });
                }}
              />
            ) : (
              <p role="alert">
                Unknown field: {field}. Remove it or restore its declaration.
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                const fields = { ...template.fields };
                delete fields[field];
                onChange({ ...template, fields });
              }}
            >
              Remove field {field}
            </Button>
          </div>
        );
      })}
      <div className="flex gap-2">
        <select
          aria-label={`Field for template ${index + 1}`}
          className={INPUT}
          value={newField}
          onChange={(event) => setNewField(event.target.value)}
        >
          <option value="">Choose field</option>
          {available.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          isDisabled={!available.includes(newField)}
          onPress={() => {
            const definition = definitions.get(newField);
            if (!definition) return;
            const value =
              definition.default ??
              (definition.type === "bool"
                ? false
                : definition.type === "number"
                  ? 0
                  : definition.type === "multi_select"
                    ? []
                    : "");
            onChange({
              ...template,
              fields: { ...template.fields, [newField]: value },
            });
            setNewField("");
          }}
        >
          Add field
        </Button>
      </div>
      <label className="text-sm text-mute">
        Body (optional)
        <textarea
          aria-label={`Template ${index + 1} body`}
          className={INPUT}
          value={template.body ?? ""}
          onChange={(event) =>
            onChange({ ...template, body: event.target.value || undefined })
          }
        />
      </label>
      <Button size="sm" variant="danger" onPress={onRemove}>
        Remove template {template.name || index + 1}
      </Button>
    </fieldset>
  );
}

export function RowTemplatesEditor({
  draft,
  onChange,
  registerFocus,
}: {
  draft: BaseDraft;
  onChange(templates: NonNullable<BaseDraft["templates"]>): void;
  registerFocus: RegisterFocusTarget;
}) {
  const templates = draft.templates ?? [];
  return (
    <section
      className="grid gap-4"
      ref={(node) => registerFocus("templates", node)}
      tabIndex={-1}
    >
      <DefinitionSectionHeading
        id="row-templates-heading"
        title="Row templates"
        description="Named creation prefills, separate from source-rendering templates. Membership rules override template values; templates override defaults. Existing pages are never changed."
      />
      {templates.map((template, index) => (
        <TemplateEditor
          key={template.id}
          template={template}
          index={index}
          properties={draft.properties}
          registerFocus={registerFocus}
          onChange={(next) =>
            onChange(templates.map((item, i) => (i === index ? next : item)))
          }
          onRemove={() => onChange(templates.filter((_, i) => i !== index))}
        />
      ))}
      <Button
        variant="secondary"
        onPress={() =>
          onChange([
            ...templates,
            { id: crypto.randomUUID(), name: "", fields: {} },
          ])
        }
      >
        Add row template
      </Button>
    </section>
  );
}
