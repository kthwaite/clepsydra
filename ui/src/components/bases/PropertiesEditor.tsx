import { useEffect, useRef, useState } from "react";
import type { PropertyType } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { Select, SelectItem } from "#/components/ui/select";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty } from "./definition-model";
import { moveItem } from "./definition-model";
import {
  PROPERTY_TYPES,
  PropertyDefinitionEditor,
} from "./PropertyDefinitionEditor";

export const SYSTEM_PROPERTY_FIELDS = [
  "id",
  "path",
  "title",
  "kind",
  "project",
  "tags",
  "aliases",
  "created_at",
  "updated_at",
  "encryption",
  "journal_date",
  "word_count",
] as const;

const RESERVED_PROPERTY_FIELDS: Record<
  (typeof SYSTEM_PROPERTY_FIELDS)[number] | "body",
  true
> = {
  id: true,
  path: true,
  title: true,
  kind: true,
  project: true,
  tags: true,
  aliases: true,
  created_at: true,
  updated_at: true,
  encryption: true,
  journal_date: true,
  word_count: true,
  body: true,
};

const TYPE_LABELS: Record<PropertyType, string> = {
  text: "Text",
  number: "Number",
  bool: "Boolean",
  date: "Date",
  datetime: "Date and time",
  select: "Select",
  multi_select: "Multi-select",
  url: "URL",
  relation: "Relation",
};

export interface PropertiesEditorProps {
  slug: string;
  properties: DraftProperty[];
  persistedPropertyIds: ReadonlySet<string>;
  onChange(properties: DraftProperty[]): void;
  onDiagnosticsChange(diagnostics: BaseDiagnostic[]): void;
  registerFocus: RegisterFocusTarget;
}

interface PendingRename {
  property: DraftProperty;
  key: string;
}

function keyError(
  key: string,
  properties: readonly DraftProperty[],
  excludingId?: string,
) {
  const normalized = key.trim();
  if (!normalized) return "Property key is required.";
  if (Object.hasOwn(RESERVED_PROPERTY_FIELDS, normalized))
    return `“${normalized}” is a reserved system field.`;
  if (
    properties.some(
      (property) => property.id !== excludingId && property.key === normalized,
    )
  )
    return `“${normalized}” is already declared.`;
  return undefined;
}

export function PropertiesEditor({
  slug,
  properties,
  persistedPropertyIds,
  onChange,
  onDiagnosticsChange,
  registerFocus,
}: PropertiesEditorProps) {
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState<PropertyType>("text");
  const [addValidationMessage, setAddValidationMessage] = useState<string>();
  const [renameDiagnostic, setRenameDiagnostic] = useState<{
    propertyId: string;
    propertyKey: string;
    message: string;
  }>();
  const [activeRenameId, setActiveRenameId] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<DraftProperty>();
  const [pendingRename, setPendingRename] = useState<PendingRename>();
  const newKeyInput = useRef<HTMLInputElement>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const [focusPropertyId, setFocusPropertyId] = useState<string>();
  const reorderHandles = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!focusPropertyId) return;
    if (!properties.some(({ id }) => id === focusPropertyId)) return;
    const handle = reorderHandles.current.get(focusPropertyId);
    if (!handle) return;
    handle.focus();
    setFocusPropertyId(undefined);
  }, [focusPropertyId, properties]);

  useEffect(() => {
    const nextDiagnostics: BaseDiagnostic[] = [];
    if (addValidationMessage) {
      nextDiagnostics.push({
        slug,
        severity: "error",
        path: "properties",
        message: addValidationMessage,
      });
    }
    if (renameDiagnostic) {
      nextDiagnostics.push({
        slug,
        severity: "error",
        path: `properties.${renameDiagnostic.propertyKey}`,
        message: renameDiagnostic.message,
      });
    }
    onDiagnosticsChange(nextDiagnostics);
  }, [addValidationMessage, onDiagnosticsChange, renameDiagnostic, slug]);

  useEffect(
    () => () => {
      onDiagnosticsChange([]);
    },
    [onDiagnosticsChange],
  );

  function addProperty() {
    const error = keyError(newKey, properties);
    setAddValidationMessage(error);
    if (error) {
      newKeyInput.current?.focus();
      return;
    }
    const key = newKey.trim();
    onChange([
      ...properties,
      {
        id: crypto.randomUUID(),
        key,
        definition: {
          type: newType,
          ...(newType === "select" || newType === "multi_select"
            ? { options: [] }
            : {}),
          ...(newType === "relation" ? { many: true } : {}),
        },
      },
    ]);
    setNewKey("");
    setAddValidationMessage(undefined);
  }

  function requestRename(property: DraftProperty, requestedKey: string) {
    const error =
      keyError(requestedKey, properties, property.id) ??
      (requestedKey.trim() === property.key
        ? "Choose a different key for the new declaration."
        : undefined);
    if (error) {
      setRenameDiagnostic({
        propertyId: property.id,
        propertyKey: property.key,
        message: error,
      });
      return;
    }
    setRenameDiagnostic(undefined);
    const key = requestedKey.trim();
    if (persistedPropertyIds.has(property.id)) {
      setPendingRename({ property, key });
      return;
    }
    setActiveRenameId(undefined);
    onChange(
      properties.map((current) =>
        current.id === property.id
          ? { ...current, id: crypto.randomUUID(), key }
          : current,
      ),
    );
  }

  function removeProperty(property: DraftProperty) {
    if (persistedPropertyIds.has(property.id)) {
      setPendingRemoval(property);
      return;
    }
    onChange(properties.filter((current) => current.id !== property.id));
  }

  function replaceProperty(property: DraftProperty) {
    onChange(
      properties.map((current) =>
        current.id === property.id ? property : current,
      ),
    );
  }

  function moveProperty(from: number, to: number) {
    if (
      from < 0 ||
      to < 0 ||
      from >= properties.length ||
      to >= properties.length
    )
      return;
    const moved = properties[from];
    if (!moved || from === to) return;
    setFocusPropertyId(moved.id);
    setMoveAnnouncement(
      `Moved ${moved.key} to position ${to + 1} of ${properties.length}.`,
    );
    onChange(moveItem(properties, from, to));
  }

  function dropProperty(
    sourceId: string,
    targetId: string,
    edge: "top" | "bottom",
  ) {
    const sourceIndex = properties.findIndex(({ id }) => id === sourceId);
    const targetIndex = properties.findIndex(({ id }) => id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex)
      return;

    const insertionIndex = targetIndex + (edge === "bottom" ? 1 : 0);
    const destinationIndex =
      insertionIndex - (sourceIndex < insertionIndex ? 1 : 0);
    moveProperty(sourceIndex, destinationIndex);
  }

  return (
    <section aria-labelledby="properties-editor-heading">
      <h2
        id="properties-editor-heading"
        className="text-sm font-bold uppercase tracking-widest text-foreground"
      >
        Properties
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Ordered declarations describe frontmatter values without owning or
        rewriting page data.
      </p>

      <div className="mt-5 border-y border-border py-4">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-foreground">
          Add declaration
        </h3>
        <div className="mt-3 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
          <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            New property key
            <input
              ref={(element) => {
                newKeyInput.current = element;
                registerFocus("properties", element);
              }}
              value={newKey}
              aria-invalid={addValidationMessage ? true : undefined}
              aria-describedby={
                addValidationMessage ? "property-key-error" : undefined
              }
              onBlur={() => {
                if (newKey)
                  setAddValidationMessage(keyError(newKey, properties));
              }}
              onChange={(event) => {
                setNewKey(event.target.value);
                if (addValidationMessage)
                  setAddValidationMessage(
                    keyError(event.target.value, properties),
                  );
              }}
              className="mt-1 block w-full border border-input bg-background px-3 py-2 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            />
          </label>
          <Select
            label="New property type"
            value={newType}
            onChange={(key) => {
              if (key == null) return;
              const type = String(key) as PropertyType;
              if (!PROPERTY_TYPES.includes(type)) return;
              setNewType(type);
            }}
          >
            {PROPERTY_TYPES.map((type) => (
              <SelectItem key={type} id={type}>
                {TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </Select>
          <Button variant="primary" onPress={addProperty}>
            Add property
          </Button>
        </div>
        {addValidationMessage && (
          <p
            id="property-key-error"
            role="alert"
            className="mt-2 text-sm text-destructive"
          >
            {addValidationMessage}
          </p>
        )}
      </div>

      {properties.length === 0 ? (
        <div className="border-b border-border py-6">
          <p className="text-sm font-medium text-foreground">
            No declarations yet
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Add a typed key above. Pages remain valid even when their
            frontmatter contains undeclared keys.
          </p>
        </div>
      ) : (
        <>
          <table
            className="mt-4 w-full table-fixed border-collapse"
            aria-label="Ordered property declarations"
          >
            <thead>
              <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <th scope="col" className="w-10 px-1 py-2 sm:px-2">
                  <span className="sr-only">Order</span>
                </th>
                <th scope="col" className="px-2 py-2 sm:px-3">
                  Key
                </th>
                <th scope="col" className="px-2 py-2 sm:px-3">
                  Type and configuration
                </th>
                <th
                  scope="col"
                  className="w-28 px-1 py-2 text-right sm:w-48 sm:px-2"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {properties.map((property, index) => (
                <PropertyDefinitionEditor
                  key={property.id}
                  property={property}
                  index={index}
                  count={properties.length}
                  persisted={persistedPropertyIds.has(property.id)}
                  renaming={activeRenameId === property.id}
                  renameError={
                    renameDiagnostic?.propertyId === property.id
                      ? renameDiagnostic.message
                      : undefined
                  }
                  onChange={replaceProperty}
                  onMove={moveProperty}
                  onReorder={dropProperty}
                  onHandleRef={(propertyId, element) => {
                    if (element)
                      reorderHandles.current.set(propertyId, element);
                    else reorderHandles.current.delete(propertyId);
                  }}
                  onRemove={removeProperty}
                  onRename={requestRename}
                  onStartRename={() => {
                    setActiveRenameId(property.id);
                    setRenameDiagnostic(undefined);
                  }}
                  onCancelRename={() => {
                    setActiveRenameId((current) =>
                      current === property.id ? undefined : current,
                    );
                    setRenameDiagnostic((current) =>
                      current?.propertyId === property.id ? undefined : current,
                    );
                  }}
                  registerFocus={registerFocus}
                />
              ))}
            </tbody>
          </table>
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {moveAnnouncement}
          </p>
        </>
      )}

      <aside
        aria-label="Read-only system fields"
        className="mt-6 border-t border-border pt-4"
      >
        <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-foreground">
          Read-only system fields
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          These bare names are supplied by Clepsydra and cannot be declared.
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 font-mono text-xs text-muted-foreground">
          {SYSTEM_PROPERTY_FIELDS.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      </aside>

      <Dialog
        isOpen={Boolean(pendingRemoval)}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(undefined);
        }}
        title={
          pendingRemoval ? `Remove ${pendingRemoval.key}` : "Remove declaration"
        }
        description="This is a schema-only change."
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setPendingRemoval(undefined)}
            >
              Keep declaration
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                if (!pendingRemoval) return;
                onChange(
                  properties.filter(
                    (property) => property.id !== pendingRemoval.id,
                  ),
                );
                setPendingRemoval(undefined);
              }}
            >
              Remove declaration
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-muted-foreground">
          Removing this declaration does not remove values from pages. Page
          frontmatter remains unchanged.
        </p>
      </Dialog>

      <Dialog
        isOpen={Boolean(pendingRename)}
        onOpenChange={(open) => {
          if (!open) setPendingRename(undefined);
        }}
        title={
          pendingRename
            ? `Rename ${pendingRename.property.key}`
            : "Rename declaration"
        }
        description="The saved key is immutable; rename removes one declaration and adds another."
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setPendingRename(undefined)}
            >
              Cancel rename
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                if (!pendingRename) return;
                onChange(
                  properties.map((property) =>
                    property.id === pendingRename.property.id
                      ? {
                          ...property,
                          id: crypto.randomUUID(),
                          key: pendingRename.key,
                        }
                      : property,
                  ),
                );
                setActiveRenameId(undefined);
                setPendingRename(undefined);
              }}
            >
              Remove and add declaration
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-muted-foreground">
          This changes the declaration only. Existing page frontmatter is not
          renamed.
        </p>
      </Dialog>
    </section>
  );
}
