import { describe, expect, it } from "vitest";
import { useAssignBulk, useAssignPage } from "#/api/pages";

describe("assign hooks", () => {
  it("are exported", () => {
    expect(typeof useAssignPage).toBe("function");
    expect(typeof useAssignBulk).toBe("function");
  });
});
