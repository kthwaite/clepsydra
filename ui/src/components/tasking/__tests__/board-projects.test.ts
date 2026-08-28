import { describe, expect, it } from "vitest";
import { deriveProjectScopes, scopeLabel } from "../board-projects";
import { BOARD_FIXTURE, NO_SLUG_OP } from "./fixtures";

const { operations, tasks } = BOARD_FIXTURE;

describe("deriveProjectScopes", () => {
  it("maps each operation to a scope keyed by opKey", () => {
    const scopes = deriveProjectScopes(operations, []);
    expect(scopes).toEqual([
      {
        key: "alpha",
        slug: "alpha",
        code: "OPS-1",
        name: "Operation Alpha",
        health: "GREEN",
        op: operations[0],
      },
      {
        key: "beta",
        slug: "beta",
        code: "OPS-2",
        name: "Operation Beta",
        health: "AMBER",
        op: operations[1],
      },
    ]);
  });

  it("does not duplicate an operation whose project matches a task slug", () => {
    const scopes = deriveProjectScopes(operations, tasks);
    expect(scopes.map((s) => s.key)).toEqual(["alpha", "beta"]);
  });

  it("synthesizes a scope per task slug with no backing operation", () => {
    const scopes = deriveProjectScopes([], tasks);
    expect(scopes).toEqual([
      {
        key: "alpha",
        slug: "alpha",
        code: "ALPHA",
        name: "",
        health: null,
        op: null,
      },
      {
        key: "beta",
        slug: "beta",
        code: "BETA",
        name: "",
        health: null,
        op: null,
      },
    ]);
  });

  it("ignores null-project tasks", () => {
    const nullOnly = tasks.filter((t) => !t.project);
    expect(nullOnly).toHaveLength(1);
    expect(deriveProjectScopes([], nullOnly)).toEqual([]);
  });

  it("keeps a slug-less op keyed by its code", () => {
    const scopes = deriveProjectScopes([NO_SLUG_OP], []);
    expect(scopes).toEqual([
      {
        key: "OPS-3",
        slug: null,
        code: "OPS-3",
        name: "Operation Gamma",
        health: "GREEN",
        op: NO_SLUG_OP,
      },
    ]);
  });

  it("sorts operations and synthesized scopes together by code", () => {
    const ghost = { ...tasks[0], id: "tg", project: "ghost" };
    const scopes = deriveProjectScopes(operations, [...tasks, ghost]);
    expect(scopes.map((s) => s.code)).toEqual(["GHOST", "OPS-1", "OPS-2"]);
    expect(scopes[0]).toEqual({
      key: "ghost",
      slug: "ghost",
      code: "GHOST",
      name: "",
      health: null,
      op: null,
    });
  });
});

describe("scopeLabel", () => {
  it("collapses to the code when the name is the same word in another case", () => {
    const falls = {
      key: "falls",
      slug: "falls",
      code: "FALLS",
      name: "Falls",
      health: "GREEN",
      op: null,
    };
    expect(scopeLabel(falls)).toBe("FALLS");
  });

  it("joins code and name for an operation-backed scope", () => {
    const [alpha] = deriveProjectScopes(operations, []);
    expect(scopeLabel(alpha)).toBe("OPS-1 — Operation Alpha");
  });

  it("returns the code alone for a synthesized scope", () => {
    const [ghost] = deriveProjectScopes(
      [],
      [{ ...tasks[0], project: "ghost" }],
    );
    expect(scopeLabel(ghost)).toBe("GHOST");
  });
});
