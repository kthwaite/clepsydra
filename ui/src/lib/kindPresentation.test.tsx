import { describe, expect, it } from "vitest";
import { presentationFor } from "#/lib/kindPresentation";

describe("presentationFor", () => {
  it("returns the generic fallback for kinds with no bespoke renderer", () => {
    const p = presentationFor("NOTE");
    expect(p.metaExtras).toBeNull();
  });
  it("never throws for any known kind", () => {
    for (const k of ["NOTE","PROJECT","JOURNAL","TODO","QUOTE","BOOK","CAPTURE","CODE","PERSON"] as const) {
      expect(() => presentationFor(k)).not.toThrow();
    }
  });
});
