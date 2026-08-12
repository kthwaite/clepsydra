import { useId, useState } from "react";
import {
  type PageBasePropertiesResponse,
  type PageBaseProperty,
  type PagePropertyBlocker,
  type PropertyDefinition,
  type PropertyType,
  usePageBaseProperties,
  usePropertyCommit,
} from "#/api/bases";
import { formatApiError, isApiConflict, isApiError } from "#/api/error";
import {
  type CellValue,
  formatCellValue,
} from "#/components/bases/cells/types";
import { EditableCell } from "#/components/bases/EditableCell";
import { cn } from "#/lib/cn";

interface FolioPropertiesProps {
  pageId: string;
  path: string;
  locked: boolean;
  readOnly: boolean;
}

interface FailedSave {
  key: string;
  value: CellValue;
  hint?: PropertyType;
  conflict: boolean;
  message: string;
}

function formatBaseNames(
  bases: PageBasePropertiesResponse["matching_bases"],
): string {
  const names = bases.map((base) => base.name);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function describeDefinition(definition: PropertyDefinition): string {
  const options = definition.options ?? [];
  const optionDetail = options.length > 0 ? ` [${options.join(", ")}]` : "";
  const relationDetail =
    definition.type === "relation" && definition.many != null
      ? definition.many
        ? " (many)"
        : " (one)"
      : "";
  return `${definition.type}${optionDetail}${relationDetail}`;
}

interface PropertyGroup {
  id: string;
  label: string;
  properties: PageBaseProperty[];
}

function groupProperties(
  projection: PageBasePropertiesResponse,
): PropertyGroup[] {
  const bySlug = new Map<string, PropertyGroup>(
    projection.matching_bases.map((base) => [
      base.slug,
      { id: `base-${base.slug}`, label: base.name, properties: [] },
    ]),
  );
  const shared: PropertyGroup = {
    id: "shared",
    label: "Shared",
    properties: [],
  };

  for (const property of projection.properties) {
    if (property.declarations.length > 1) {
      shared.properties.push(property);
      continue;
    }
    const declaration = property.declarations[0];
    if (declaration)
      bySlug.get(declaration.base.slug)?.properties.push(property);
  }

  const groups = projection.matching_bases
    .map((base) => bySlug.get(base.slug))
    .filter((group): group is PropertyGroup =>
      Boolean(group?.properties.length),
    );
  if (shared.properties.length > 0) groups.push(shared);
  return groups;
}

function propertyTypeLabel(property: PageBaseProperty): string {
  if (property.definition) return property.definition.type;
  return Array.from(
    new Set(property.declarations.map(({ definition }) => definition.type)),
  ).join(" / ");
}

function blockerLabel(blocker: PagePropertyBlocker): string {
  switch (blocker) {
    case "schema_conflict":
      return "Schema conflict";
    case "reserved_key":
      return "Reserved property";
  }
}

function isPropertyRevisionConflict(error: unknown): boolean {
  if (isApiConflict(error)) return true;
  if (!isApiError(error)) return false;
  const detail = error.detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    "revision" in detail &&
    typeof detail.revision === "string"
  );
}

function propertyCellValue(property: PageBaseProperty): CellValue {
  if (!property.present) return null;
  return property.value as CellValue;
}

function displayPropertyValue(property: PageBaseProperty): string {
  if (property.blockers.includes("reserved_key")) return "Not exposed";
  if (!property.present) return "Not set";
  if (property.value === null) return "null";
  const formatted = formatCellValue(property.value as CellValue);
  return formatted === "" ? "Empty value" : formatted;
}

const ACTION_CLASS = cn(
  "cl-mono border border-rule px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-ink-2",
  "hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
);

/**
 * Backend-authoritative Base properties for one Folio. Editing delegates to the
 * same typed cells and revision-guarded PATCH path as Base tables.
 */
export function FolioProperties({
  pageId,
  path,
  locked,
  readOnly,
}: FolioPropertiesProps) {
  const projection = usePageBaseProperties(pageId);
  const commit = usePropertyCommit();
  const id = useId();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [failedSave, setFailedSave] = useState<FailedSave | null>(null);
  const [focusReturnKey, setFocusReturnKey] = useState<string | null>(null);

  if (!pageId) return null;

  const retryProjection = () => {
    void projection.refetch();
  };

  const discardDraft = (key: string) => {
    setFailedSave(null);
    setEditingKey(null);
    setFocusReturnKey(key);
  };

  const saveProperty = async (
    property: PageBaseProperty,
    value: CellValue,
    hint?: PropertyType,
  ) => {
    const current = projection.data;
    if (!current || savingKey !== null) return;

    setSavingKey(property.key);
    setFailedSave(null);
    try {
      await commit(
        { id: pageId, path },
        property.key,
        value,
        hint,
        current.revision,
      );
      await projection.refetch();
      setEditingKey(null);
      setFocusReturnKey(property.key);
    } catch (error) {
      setFailedSave({
        key: property.key,
        value,
        hint,
        conflict: isPropertyRevisionConflict(error),
        message: formatApiError(
          error,
          `Could not update ${property.key}. The draft is still available.`,
        ),
      });
    } finally {
      setSavingKey(null);
    }
  };

  const errorMessage = projection.isError
    ? formatApiError(
        projection.error,
        "Property projection is temporarily unavailable.",
      )
    : null;
  const groups = projection.data ? groupProperties(projection.data) : [];

  if (!projection.isError && projection.data?.matching_bases.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="mt-3 border-y border-rule py-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2
          id={`${id}-heading`}
          className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute"
        >
          Properties
        </h2>
        {projection.isFetching ? (
          <span className="cl-mono text-[8px] uppercase tracking-[0.12em] text-ink-mute">
            Refreshing…
          </span>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="mb-2 border border-hot/40 bg-hot/5 p-2">
          <p role="alert" className="cl-marg m-0 text-[11px] text-hot">
            {errorMessage}
          </p>
          <button
            type="button"
            className={cn(ACTION_CLASS, "mt-2")}
            onClick={retryProjection}
          >
            Retry loading properties
          </button>
        </div>
      ) : null}

      {!projection.data && projection.isLoading ? (
        <p className="cl-marg m-0">Loading properties…</p>
      ) : null}

      {projection.data &&
      projection.data.matching_bases.length > 0 &&
      projection.data.properties.length === 0 ? (
        <div>
          <p className="cl-mono m-0 text-[10px] font-semibold text-ink-2">
            No declared properties
          </p>
          <p className="cl-marg mt-1 mb-0">
            {formatBaseNames(projection.data.matching_bases)} match
            {projection.data.matching_bases.length === 1 ? "es" : ""} this page.
          </p>
        </div>
      ) : null}

      {groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map((group) => {
            const groupHeadingId = `${id}-group-${group.id}`;

            return (
              <section key={group.id} aria-labelledby={groupHeadingId}>
                <h3
                  id={groupHeadingId}
                  className="cl-mono mb-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute"
                >
                  {group.label}
                </h3>
                <ul className="m-0 space-y-1 p-0">
                  {group.properties.map((property, index) => {
                    const provenanceId = `${id}-provenance-${group.id}-${index}`;
                    const errorId = `${id}-error-${group.id}-${index}`;
                    const propertyFailure =
                      failedSave?.key === property.key ? failedSave : null;
                    const describedBy = propertyFailure
                      ? `${provenanceId} ${errorId}`
                      : provenanceId;
                    const canEdit =
                      !locked &&
                      !readOnly &&
                      property.compatibility === "compatible" &&
                      property.patchable &&
                      property.definition !== null;
                    const readOnlyReason = locked
                      ? "Page is locked"
                      : readOnly
                        ? "Folio is read-only"
                        : null;
                    const blockers = property.blockers.map(blockerLabel);
                    if (!canEdit && !readOnlyReason && blockers.length === 0) {
                      blockers.push("Read-only property");
                    }

                    return (
                      <li
                        key={property.key}
                        className="grid list-none gap-x-4 gap-y-0.5 py-0.5 sm:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]"
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h4 className="cl-mono m-0 break-all text-[10px] font-semibold text-ink-2">
                              {property.key}
                            </h4>
                            <span className="cl-mono shrink-0 text-[8px] text-ink-mute">
                              {propertyTypeLabel(property)}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {readOnlyReason ? (
                              <span className="cl-mono text-[8px] uppercase tracking-[0.08em] text-ink-mute">
                                {readOnlyReason}
                              </span>
                            ) : null}
                            {blockers.map((blocker) => (
                              <span
                                key={blocker}
                                className="cl-mono text-[8px] uppercase tracking-[0.08em] text-hot"
                              >
                                {blocker}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="min-w-0">
                          {canEdit && property.definition ? (
                            <EditableCell
                              value={propertyCellValue(property)}
                              definition={property.definition}
                              isEditing={editingKey === property.key}
                              focusOnDisplay={focusReturnKey === property.key}
                              preserveEditingOnBlur={propertyFailure !== null}
                              ariaLabel={`${property.key} property`}
                              ariaDescribedBy={describedBy}
                              onEdit={() => {
                                setEditingKey(property.key);
                                setFocusReturnKey(null);
                                setFailedSave(null);
                              }}
                              onCancel={() => discardDraft(property.key)}
                              onCommit={(value, hint) => {
                                void saveProperty(property, value, hint);
                              }}
                              onCommitNext={(value, hint) => {
                                void saveProperty(property, value, hint);
                              }}
                            />
                          ) : (
                            <p
                              aria-describedby={provenanceId}
                              className="cl-mono m-0 break-words text-[11px] text-ink-2"
                            >
                              {displayPropertyValue(property)}
                            </p>
                          )}

                          <ul
                            id={provenanceId}
                            className="sr-only"
                            style={{ opacity: 0 }}
                          >
                            {property.declarations.map(
                              (declaration, declarationIndex) => (
                                <li
                                  key={`${declaration.base.slug}-${declarationIndex}`}
                                  className="cl-mono list-none text-[8px] leading-relaxed text-ink-mute"
                                >
                                  {declaration.base.name} (
                                  {declaration.base.slug}) ·{" "}
                                  {describeDefinition(declaration.definition)}
                                </li>
                              ),
                            )}
                          </ul>

                          {savingKey === property.key ? (
                            <p
                              role="status"
                              className="cl-mono mt-1 mb-0 text-[8px] uppercase tracking-[0.08em] text-ink-mute"
                            >
                              Saving {property.key}…
                            </p>
                          ) : null}

                          {propertyFailure ? (
                            <div id={errorId} className="mt-1">
                              <p
                                role="alert"
                                className="cl-marg m-0 text-[11px] text-hot"
                              >
                                {propertyFailure.message}
                              </p>
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {propertyFailure.conflict ? (
                                  <button
                                    type="button"
                                    className={ACTION_CLASS}
                                    onMouseDown={(event) =>
                                      event.preventDefault()
                                    }
                                    onClick={retryProjection}
                                  >
                                    Reload current properties
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className={ACTION_CLASS}
                                    onMouseDown={(event) =>
                                      event.preventDefault()
                                    }
                                    onClick={() => {
                                      void saveProperty(
                                        property,
                                        propertyFailure.value,
                                        propertyFailure.hint,
                                      );
                                    }}
                                  >
                                    Retry saving {property.key}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={ACTION_CLASS}
                                  onMouseDown={(event) =>
                                    event.preventDefault()
                                  }
                                  onClick={() => discardDraft(property.key)}
                                >
                                  Discard {property.key} draft
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
