import type {
  BaseDetailResponse,
  BaseMemberCapability,
  PropertyDefinition,
} from "#/api/bases";
import type { CellValue } from "./cells/types";
import { asciiCaseFold } from "./local-validation";

const CREATABLE_SYSTEM: Record<
  Exclude<DraftFieldKind, "title" | "property">,
  true
> = {
  kind: true,
  project: true,
  tags: true,
  aliases: true,
};
const READ_ONLY_SYSTEM: Record<string, true> = {
  id: true,
  path: true,
  created_at: true,
  updated_at: true,
  journal_date: true,
  word_count: true,
};

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

const SYSTEM_FIELDS: Record<string, true> = {
  title: true,
  ...CREATABLE_SYSTEM,
  ...READ_ONLY_SYSTEM,
};

interface ResolvedDraftField {
  identity: string;
  key: string;
  bare: string;
  source: "system" | "property";
}

function resolveDraftField(
  rawField: string,
  properties: NonNullable<BaseDetailResponse["properties"]>,
): ResolvedDraftField | undefined {
  if (rawField.startsWith("prop.")) {
    const bare = rawField.slice(5);
    if (!Object.hasOwn(properties, bare)) return undefined;
    return {
      identity: `property:${bare}`,
      key: Object.hasOwn(SYSTEM_FIELDS, bare) ? `prop.${bare}` : bare,
      bare,
      source: "property",
    };
  }

  const bare = rawField.startsWith("sys.") ? rawField.slice(4) : rawField;
  if (Object.hasOwn(SYSTEM_FIELDS, bare)) {
    return {
      identity: `system:${bare}`,
      key: bare,
      bare,
      source: "system",
    };
  }
  if (!Object.hasOwn(properties, bare)) return undefined;
  return {
    identity: `property:${bare}`,
    key: bare,
    bare,
    source: "property",
  };
}

function isCreatableSystemField(
  field: string,
): field is Exclude<DraftFieldKind, "title" | "property"> {
  return Object.hasOwn(CREATABLE_SYSTEM, field);
}

export function composeMemberDraftFields(
  definition: BaseDetailResponse,
  viewName: string,
  capability: BaseMemberCapability,
): BaseMemberDraftField[] {
  const view = definition.views?.find(
    (candidate) => asciiCaseFold(candidate.name) === asciiCaseFold(viewName),
  );
  const properties = definition.properties ?? {};
  const ordered = [
    "title",
    ...(view?.columns ?? []),
    ...capability.fields.map((item) => item.field),
  ];
  const requirements = new Map<
    string,
    { membership: boolean; viewOnly: boolean }
  >();
  for (const requirement of capability.fields) {
    const resolved = resolveDraftField(requirement.field, properties);
    if (!resolved) continue;
    const current = requirements.get(resolved.identity);
    requirements.set(resolved.identity, {
      membership: (current?.membership ?? false) || requirement.membership,
      viewOnly: (current?.viewOnly ?? false) || requirement.view,
    });
  }

  const seen = new Set<string>();
  const fields: BaseMemberDraftField[] = [];
  for (const rawField of ordered) {
    const resolved = resolveDraftField(rawField, properties);
    if (!resolved || seen.has(resolved.identity)) continue;
    seen.add(resolved.identity);

    const labels = requirements.get(resolved.identity) ?? {
      membership: false,
      viewOnly: false,
    };
    if (resolved.source === "system") {
      if (Object.hasOwn(READ_ONLY_SYSTEM, resolved.bare)) continue;
      if (resolved.bare === "title") {
        fields.push({ key: resolved.key, kind: "title", ...labels });
      } else if (isCreatableSystemField(resolved.bare)) {
        fields.push({ key: resolved.key, kind: resolved.bare, ...labels });
      }
      continue;
    }

    fields.push({
      key: resolved.key,
      kind: "property",
      definition: properties[resolved.bare],
      ...labels,
    });
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
