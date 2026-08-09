import type {
  BaseDetailResponse,
  BaseMemberCapability,
  PropertyDefinition,
} from "#/api/bases";
import type { CellValue } from "./cells/types";
import { asciiCaseFold } from "./local-validation";

const CREATABLE_SYSTEM: ReadonlySet<string> = new Set([
  "kind",
  "project",
  "tags",
  "aliases",
]);
const READ_ONLY_SYSTEM: ReadonlySet<string> = new Set([
  "id",
  "path",
  "created_at",
  "updated_at",
  "journal_date",
  "word_count",
]);

export type DraftFieldKind =
  | "title"
  | "kind"
  | "project"
  | "tags"
  | "aliases"
  | "property";

export interface BaseMemberDraftField {
  key: string;
  kind: DraftFieldKind;
  definition?: PropertyDefinition;
  membership: boolean;
  viewOnly: boolean;
}

export interface BaseMemberDraftValue {
  title: string;
  fields: Record<string, CellValue>;
}

function normalizedField(field: string): string {
  if (field.startsWith("sys.")) return field.slice(4);
  if (field.startsWith("prop.")) return field.slice(5);
  return field;
}

function isCreatableSystemField(
  field: string,
): field is Exclude<DraftFieldKind, "title" | "property"> {
  return CREATABLE_SYSTEM.has(field);
}

export function composeMemberDraftFields(
  definition: BaseDetailResponse,
  viewName: string,
  capability: BaseMemberCapability,
): BaseMemberDraftField[] {
  const view = definition.views?.find(
    (candidate) => asciiCaseFold(candidate.name) === asciiCaseFold(viewName),
  );
  const ordered = [
    "title",
    ...(view?.columns ?? []),
    ...capability.fields.map((item) => item.field),
  ];
  const requirements = new Map<
    string,
    BaseMemberCapability["fields"][number]
  >();
  for (const requirement of capability.fields) {
    const key = normalizedField(requirement.field);
    if (!requirements.has(key)) requirements.set(key, requirement);
  }

  const properties = definition.properties ?? {};
  const seen = new Set<string>();
  const fields: BaseMemberDraftField[] = [];
  for (const rawField of ordered) {
    const key = normalizedField(rawField);
    if (seen.has(key)) continue;
    seen.add(key);

    if (READ_ONLY_SYSTEM.has(key)) continue;
    const requirement = requirements.get(key);
    const labels = {
      membership: requirement?.membership ?? false,
      viewOnly: requirement?.view ?? false,
    };
    if (key === "title") {
      fields.push({ key, kind: "title", ...labels });
      continue;
    }

    const propertyDefinition = Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
    if (propertyDefinition) {
      fields.push({
        key,
        kind: "property",
        definition: propertyDefinition,
        ...labels,
      });
      continue;
    }

    if (isCreatableSystemField(key)) {
      fields.push({ key, kind: key, ...labels });
    }
  }
  return fields;
}

export function initialMemberDraft(
  fields: readonly BaseMemberDraftField[],
): BaseMemberDraftValue {
  const values: Record<string, CellValue> = {};
  for (const field of fields) {
    if (field.kind === "kind") values[field.key] = "NOTE";
    if (field.kind === "tags" || field.kind === "aliases") {
      values[field.key] = [];
    }
  }
  return { title: "", fields: values };
}
