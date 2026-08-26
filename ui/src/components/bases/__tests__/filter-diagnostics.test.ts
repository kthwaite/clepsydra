import { describe, expect, it, vi } from "vitest";
import type { BaseDiagnostic } from "#/components/bases/BaseDefinitionWorkspace";
import { createFilterDiagnosticScope } from "#/components/bases/filter-diagnostics";

describe("createFilterDiagnosticScope", () => {
  it("derives validator paths and exact control diagnostics", () => {
    const diagnostics = [
      {
        path: "views[1].filter.all[0].value",
        severity: "error",
        message: "Bad value",
      },
    ] as BaseDiagnostic[];
    const scope = createFilterDiagnosticScope({
      root: "views[1].filter",
      path: ["all", 0],
      diagnostics,
    });

    expect(scope.path()).toBe("views[1].filter.all[0]");
    expect(scope.path("value")).toBe("views[1].filter.all[0].value");
    expect(scope.exact("value")).toEqual(diagnostics);
    expect(scope.exact("field")).toEqual([]);
  });

  it("returns node and descendant diagnostics without including siblings", () => {
    const included = [
      {
        path: "filter.all[0]",
        severity: "warning",
        message: "Node warning",
      },
      {
        path: "filter.all[0].value",
        severity: "error",
        message: "Value error",
      },
      {
        path: "filter.all[0].all[0].field",
        severity: "error",
        message: "Nested field error",
      },
    ] as BaseDiagnostic[];
    const diagnostics = [
      ...included,
      {
        path: "filter.all[1].value",
        severity: "error",
        message: "Sibling error",
      },
      {
        path: "filter.all[0]suffix",
        severity: "error",
        message: "Similar prefix error",
      },
    ] as BaseDiagnostic[];
    const scope = createFilterDiagnosticScope({
      root: "filter",
      path: ["all", 0],
      diagnostics,
    });

    expect(scope.subtree()).toEqual(included);
  });

  it("registers the exact control path and element", () => {
    const registerFocus = vi.fn();
    const element = document.createElement("input");
    const scope = createFilterDiagnosticScope({
      root: "views[1].filter",
      path: ["not"],
      diagnostics: [],
      registerFocus,
    });

    scope.register("field", element);

    expect(registerFocus).toHaveBeenCalledOnce();
    expect(registerFocus).toHaveBeenCalledWith(
      "views[1].filter.not.field",
      element,
    );
  });

  it("allows registration when no registrar is supplied", () => {
    const scope = createFilterDiagnosticScope({
      root: "filter",
      path: [],
      diagnostics: [],
    });

    expect(() => scope.register("value", null)).not.toThrow();
  });
});
