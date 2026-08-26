import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { FilterPath } from "./filter-tree";

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
