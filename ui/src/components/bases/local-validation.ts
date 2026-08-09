import type { BaseDetailResponse } from "#/api/bases";
import type { BaseDraft } from "./definition-model";

type BaseDiagnostic = BaseDetailResponse["diagnostics"][number];

export function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
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
