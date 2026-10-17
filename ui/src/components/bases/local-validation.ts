import type { BaseDetailResponse, PropertyDefinition } from "#/api/bases";
import {
  aggregateFunctions,
  type BaseDraft,
  canSort,
} from "./definition-model";
import { validateFilterDraft } from "./filter-diagnostics";
import { SYSTEM_PROPERTY_FIELDS } from "./PropertiesEditor";
import { effectiveProperties, propertyKey } from "./property-schema";

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

function advisoryValueError(
  definition: PropertyDefinition,
  value: unknown,
): string | undefined {
  let valid = false;
  switch (definition.type) {
    case "number":
      valid = typeof value === "number" && Number.isFinite(value);
      break;
    case "bool":
      valid = typeof value === "boolean";
      break;
    case "multi_select":
      valid =
        Array.isArray(value) &&
        value.every(
          (item) =>
            typeof item === "string" &&
            (!definition.options?.length || definition.options.includes(item)),
        );
      break;
    case "relation":
      valid =
        typeof value === "string" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string"));
      break;
    case "select":
      valid =
        typeof value === "string" &&
        (!definition.options?.length || definition.options.includes(value));
      break;
    case "date":
      valid =
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value));
      break;
    case "datetime":
      valid = typeof value === "string" && Number.isFinite(Date.parse(value));
      break;
    case "url":
    case "text":
      valid = typeof value === "string";
      break;
  }
  return valid
    ? undefined
    : `Value is incompatible with ${definition.type}${definition.options?.length ? " and its allowed options" : ""}.`;
}

const WRITABLE_TEMPLATE_SYSTEM: Record<string, PropertyDefinition> = {
  title: { type: "text" },
  kind: { type: "text" },
  project: { type: "text" },
  tags: { type: "multi_select" },
  aliases: { type: "multi_select" },
};
const CURRENCY_NAMES = new Intl.DisplayNames(["en"], {
  type: "currency",
  fallback: "none",
});

export function validateBaseDraftStructure(
  slug: string,
  draft: BaseDraft,
): BaseDiagnostic[] {
  const diagnostics = validateFilterDraft(draft.filter, slug);

  if (draft.name.trim().length === 0) {
    diagnostics.push({
      slug,
      severity: "error",
      path: "name",
      message: "Base name must not be empty.",
    });
  }

  const error = (path: string, message: string) =>
    diagnostics.push({ slug, severity: "error", path, message });
  for (const { key, definition } of draft.properties) {
    const path = `properties.${key}`;
    if (definition.default != null) {
      const message = advisoryValueError(definition, definition.default);
      if (message) error(`${path}.default`, message);
    }
    for (const field of ["format", "currency", "display", "target"] as const) {
      if (definition[field] != null && definition.type !== "number")
        error(
          `${path}.${field}`,
          `${field} is only valid on number properties. Clear it or restore the number type.`,
        );
    }
    if (
      definition.options != null &&
      definition.type !== "select" &&
      definition.type !== "multi_select"
    )
      error(
        `${path}.options`,
        "Options require a select or multi-select property.",
      );
    if (definition.many != null && definition.type !== "relation")
      error(`${path}.many`, "Cardinality requires a relation property.");
    if (
      definition.target != null &&
      (!Number.isFinite(definition.target) || definition.target <= 0)
    )
      error(
        `${path}.target`,
        "Progress target must be a positive finite number.",
      );
    if (definition.format === "currency" && !definition.currency)
      error(`${path}.currency`, "Choose an ISO 4217 currency code.");
    if (
      definition.currency &&
      (!/^[A-Z]{3}$/.test(definition.currency) ||
        !CURRENCY_NAMES.of(definition.currency))
    )
      error(`${path}.currency`, "Choose a recognized ISO 4217 currency code.");
    if (definition.currency && definition.format !== "currency")
      error(`${path}.currency`, "Currency is only valid with currency format.");
  }
  const templateNames = new Set<string>();
  const declared = new Map(
    draft.properties.map(({ key, definition }) => [key, definition]),
  );
  for (const [index, template] of (draft.templates ?? []).entries()) {
    const path = `templates[${index}]`;
    const name = template.name;
    if (!name.trim() || templateNames.has(name))
      error(`${path}.name`, "Template names must be nonempty and unique.");
    templateNames.add(name);
    const identities = new Set<string>();
    for (const [field, value] of Object.entries(template.fields)) {
      const property = field.startsWith("prop.");
      const bare = property
        ? field.slice(5)
        : field.startsWith("sys.")
          ? field.slice(4)
          : field;
      const isSystem =
        !property && (field.startsWith("sys.") || SYSTEM_FIELDS.has(bare));
      const definition = isSystem
        ? Object.hasOwn(WRITABLE_TEMPLATE_SYSTEM, bare)
          ? WRITABLE_TEMPLATE_SYSTEM[bare]
          : undefined
        : declared.get(bare);
      const identity = `${isSystem ? "system" : "property"}:${bare}`;
      if (identities.has(identity))
        error(
          `${path}.fields.${field}`,
          "This field is already assigned by another qualified name.",
        );
      identities.add(identity);
      if (!definition)
        error(
          `${path}.fields.${field}`,
          "Choose a declared property or writable creation field.",
        );
      else {
        const message = advisoryValueError(definition, value);
        if (message) error(`${path}.fields.${field}`, message);
      }
    }
  }
  const indexesByName = new Map<string, number[]>();
  const propertyTypes = new Map(
    effectiveProperties(draft.properties).map((property) => [
      property.key,
      property.definition.type,
    ]),
  );
  const propertyKeys = new Set(propertyTypes.keys());
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
    diagnostics.push(
      ...validateFilterDraft(view.filter, slug, `views[${index}].filter`),
    );
    for (const [ruleIndex, rule] of (view.color_rules ?? []).entries()) {
      diagnostics.push(
        ...validateFilterDraft(
          rule.filter,
          slug,
          `views[${index}].color_rules[${ruleIndex}].filter`,
        ),
      );
    }
    for (const [metricIndex, metric] of (view.metrics ?? []).entries()) {
      const path = `views[${index}].metrics[${metricIndex}]`;
      const identity = metric.field
        ? presentationFieldIdentity(metric.field)
        : undefined;
      const system = identity?.startsWith("system:")
        ? identity.slice(7)
        : undefined;
      const type = system
        ? system === "word_count"
          ? "word_count"
          : system === "tags" || system === "aliases"
            ? "system-multi"
            : system === "journal_date"
              ? "date"
              : "text"
        : metric.field
          ? propertyTypes.get(propertyKey(metric.field))
          : undefined;
      if (metric.fn !== "count" && !metric.field) {
        error(`${path}.field`, "Choose a field for this metric.");
      } else if (!aggregateFunctions(type).includes(metric.fn)) {
        error(
          `${path}.field`,
          "This metric function is not available for the selected field.",
        );
      }
      if (metric.label != null && !metric.label.trim()) {
        error(`${path}.label`, "Metric label must not be empty.");
      }
      if (metric.target != null) {
        if (!Number.isFinite(metric.target) || metric.target <= 0) {
          error(
            `${path}.target`,
            "Metric target must be a finite number greater than zero.",
          );
        } else if (
          (metric.fn === "min" ||
            metric.fn === "max" ||
            metric.fn === "median") &&
          type !== "number" &&
          type !== "word_count"
        ) {
          error(`${path}.target`, "Targets require a numeric metric result.");
        }
      }
    }
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
      const propertyType = propertyTypes.get(propertyKey(sort.field));
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
