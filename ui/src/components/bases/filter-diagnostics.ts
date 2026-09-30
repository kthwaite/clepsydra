import type { BaseFilter } from "#/api/bases";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { FilterPath } from "./filter-tree";
import { VALUELESS_OPERATORS } from "./operator-labels";

/** Empty editor rows are drafts, not silently active query predicates. */
export function validateFilterDraft(
  filter: BaseFilter | undefined,
  slug: string,
  root = "filter",
): BaseDiagnostic[] {
  if (!filter) return [];
  const diagnostics: BaseDiagnostic[] = [];
  const incomplete = (path: string, message: string) => {
    diagnostics.push({ slug, severity: "error", path, message });
  };
  const visit = (node: BaseFilter, path: string): void => {
    if ("field" in node) {
      if (!node.field.trim()) {
        incomplete(`${path}.field`, "Choose a field for this condition.");
      }
      if (
        !VALUELESS_OPERATORS[node.op] &&
        (node.value == null ||
          (typeof node.value === "string" && !node.value.trim()) ||
          (Array.isArray(node.value) && node.value.length === 0))
      ) {
        incomplete(`${path}.value`, "Choose a value or remove this condition.");
      }
      return;
    }
    if ("not" in node) {
      visit(node.not, `${path}.not`);
      return;
    }
    const kind = "all" in node ? "all" : "any";
    const children = "all" in node ? node.all : node.any;
    if (children.length === 0) {
      incomplete(path, "Add a condition or remove this empty group.");
    }
    for (const [index, child] of children.entries()) {
      visit(child, `${path}.${kind}[${index}]`);
    }
  };
  visit(filter, root);
  return diagnostics;
}

export type FilterControl = "field" | "op" | "value";

export interface FilterDiagnosticScope {
  path(control?: FilterControl): string;
  exact(control: FilterControl): BaseDiagnostic[];
  subtree(): BaseDiagnostic[];
  registerPath(path: string, element: HTMLElement | null): void;
  register(control: FilterControl, element: HTMLElement | null): void;
}

export function createFilterDiagnosticScope(options: {
  root: string;
  path: FilterPath;
  diagnostics: readonly BaseDiagnostic[];
  registerFocus?: RegisterFocusTarget;
}): FilterDiagnosticScope {
  const nodePath = options.path.reduce(
    (result, segment) =>
      result + (typeof segment === "number" ? `[${segment}]` : `.${segment}`),
    options.root,
  );
  const path = (control?: FilterControl) =>
    control === undefined ? nodePath : `${nodePath}.${control}`;
  const registerPath = (
    diagnosticPath: string,
    element: HTMLElement | null,
  ) => {
    options.registerFocus?.(diagnosticPath, element);
  };

  return {
    path,
    registerPath,
    exact(control) {
      const controlPath = path(control);
      return options.diagnostics.filter(
        (diagnostic) => diagnostic.path === controlPath,
      );
    },
    subtree() {
      return options.diagnostics.filter(
        (diagnostic) =>
          typeof diagnostic.path === "string" &&
          (diagnostic.path === nodePath ||
            diagnostic.path.startsWith(`${nodePath}.`) ||
            diagnostic.path.startsWith(`${nodePath}[`)),
      );
    },
    register(control, element) {
      registerPath(path(control), element);
    },
  };
}
