import type { BaseDetailResponse } from "#/api/bases";
import { type BaseDraft, canSort } from "./definition-model";
import { SYSTEM_PROPERTY_FIELDS } from "./PropertiesEditor";

type BaseDiagnostic = BaseDetailResponse["diagnostics"][number];

export function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

const SYSTEM_FIELDS = new Set<string>(SYSTEM_PROPERTY_FIELDS);

export function presentationFieldIdentity(field: string): string | undefined {
  if (field === "body" || field === "sys.body" || field === "prop.body") {
    return "body";
  }
  if (field.startsWith("sys.")) {
    const name = field.slice(4);
    return SYSTEM_FIELDS.has(name) ? `system:${name}` : undefined;
  }
  if (!field.startsWith("prop.") && SYSTEM_FIELDS.has(field)) {
    return `system:${field}`;
  }
  const property = field.startsWith("prop.") ? field.slice(5) : field;
  return `property:${property}`;
}

type PresentationFieldResolution = {
  identity?: string;
  warning?: string;
};

function resolvePresentationField(
  field: string,
  propertyKeys: ReadonlySet<string>,
): PresentationFieldResolution {
  const identity = presentationFieldIdentity(field);
  if (field.startsWith("sys.") && identity === undefined) {
    return { warning: `Unknown system field “${field.slice(4)}”.` };
  }

  const property = field.startsWith("prop.") ? field.slice(5) : field;
  const isProperty = identity?.startsWith("property:") ?? false;
  return {
    identity,
    ...(isProperty && !propertyKeys.has(property)
      ? {
          warning: `Property “${property}” is not declared and is unavailable.`,
        }
      : {}),
  };
}

function validatePresentationField(
  slug: string,
  field: string,
  path: string,
  propertyKeys: ReadonlySet<string>,
): { diagnostic?: BaseDiagnostic; identity?: string } {
  const resolution = resolvePresentationField(field, propertyKeys);
  return {
    identity: resolution.identity,
    ...(resolution.warning
      ? {
          diagnostic: {
            slug,
            severity: "warning" as const,
            path,
            message: resolution.warning,
          },
        }
      : {}),
  };
}

export function validateBaseDraftStructure(
  slug: string,
  draft: BaseDraft,
): BaseDiagnostic[] {
  const diagnostics: BaseDiagnostic[] = [];

  if (draft.name.trim().length === 0) {
    diagnostics.push({
      slug,
      severity: "error",
      path: "name",
      message: "Base name must not be empty.",
    });
  }

  const indexesByName = new Map<string, number[]>();
  const propertyTypes = new Map(
    draft.properties.map((property) => [
      property.key,
      property.definition.type,
    ]),
  );
  const propertyKeys = new Set(
    draft.properties.map((property) => property.key),
  );
  const previewIdentities = new Set<string>();
  for (const [previewIndex, preview] of draft.preview.entries()) {
    if (preview.label !== undefined && preview.label.trim().length === 0) {
      diagnostics.push({
        slug,
        severity: "error",
        path: `preview[${previewIndex}].label`,
        message: "Preview label must not be empty.",
      });
    }
    const path = `preview[${previewIndex}].field`;
    if (preview.field.trim().length === 0) {
      diagnostics.push({
        slug,
        severity: "error",
        path,
        message: "Preview field must not be empty.",
      });
      continue;
    }
    const { diagnostic, identity } = validatePresentationField(
      slug,
      preview.field,
      path,
      propertyKeys,
    );
    if (diagnostic) diagnostics.push(diagnostic);
    if (identity && previewIdentities.has(identity)) {
      diagnostics.push({
        slug,
        severity: "error",
        path,
        message: `Duplicate preview field “${preview.field}”.`,
      });
    } else if (identity) {
      previewIdentities.add(identity);
    }
  }
  for (const [index, view] of draft.views.entries()) {
    if (view.name.trim().length === 0) {
      diagnostics.push({
        slug,
        severity: "error",
        path: `views[${index}].name`,
        message: "View name must not be empty.",
      });
    } else {
      const equivalentName = asciiCaseFold(view.name);
      const indexes = indexesByName.get(equivalentName) ?? [];
      indexes.push(index);
      indexesByName.set(equivalentName, indexes);
    }

    if (view.layout !== "table") {
      diagnostics.push({
        slug,
        severity: "error",
        path: `views[${index}].layout`,
        message: `Unsupported layout “${view.layout}”. Choose Table to repair it.`,
      });
    }

    for (const [sortIndex, sort] of view.sort.entries()) {
      const propertyType = propertyTypes.get(sort.field);
      if (propertyType !== undefined && !canSort(propertyType)) {
        diagnostics.push({
          slug,
          severity: "error",
          path: `views[${index}].sort[${sortIndex}].field`,
          message: `Sort field “${sort.field}” cannot be sorted because ${propertyType} values are not scalar.`,
        });
      }
    }

    for (const [field, label] of Object.entries(view.labels)) {
      const path = `views[${index}].labels.${field}`;
      if (label.trim().length === 0) {
        diagnostics.push({
          slug,
          severity: "error",
          path,
          message: `View label for “${field}” must not be empty.`,
        });
      }
      const { diagnostic } = validatePresentationField(
        slug,
        field,
        path,
        propertyKeys,
      );
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }

  for (const indexes of indexesByName.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      diagnostics.push({
        slug,
        severity: "error",
        path: `views[${index}].name`,
        message: "View names must be unique (ignoring ASCII letter case).",
      });
    }
  }

  return diagnostics;
}
