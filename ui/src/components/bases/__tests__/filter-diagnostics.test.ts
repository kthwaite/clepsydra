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

  it("registers the exact control path for mount and cleanup", () => {
    const registerFocus = vi.fn();
    const element = document.createElement("input");
    const scope = createFilterDiagnosticScope({
      root: "views[1].filter",
      path: ["not"],
      diagnostics: [],
      registerFocus,
    });

    scope.register("field", element);
    scope.register("field", null);

    expect(registerFocus).toHaveBeenCalledTimes(2);
    expect(registerFocus).toHaveBeenNthCalledWith(
      1,
      "views[1].filter.not.field",
      element,
    );
    expect(registerFocus).toHaveBeenNthCalledWith(
      2,
      "views[1].filter.not.field",
      null,
    );
  });

  it("registers an exact diagnostic path for mount and cleanup", () => {
    const registerFocus = vi.fn();
    const element = document.createElement("div");
    const scope = createFilterDiagnosticScope({
      root: "filter",
      path: [],
      diagnostics: [],
      registerFocus,
    });

    scope.registerPath("filter.all[1].value", element);
    scope.registerPath("filter.all[1].value", null);

    expect(registerFocus).toHaveBeenCalledTimes(2);
    expect(registerFocus).toHaveBeenNthCalledWith(
      1,
      "filter.all[1].value",
      element,
    );
    expect(registerFocus).toHaveBeenNthCalledWith(
      2,
      "filter.all[1].value",
      null,
    );
  });

  it("allows registration when no registrar is supplied", () => {
    const element = document.createElement("input");
    const scope = createFilterDiagnosticScope({
      root: "filter",
      path: [],
      diagnostics: [],
    });

    expect(() => {
      scope.register("value", element);
      scope.registerPath("filter.all[1].value", element);
    }).not.toThrow();
  });
});
