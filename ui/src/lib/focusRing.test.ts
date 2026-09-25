import { describe, expect, it } from "vitest";
import { FOCUS_RING, FOCUS_RING_NATIVE } from "#/lib/focusRing";

describe("focus ring", () => {
  it("draws a 2px cobalt ring offset on the ground for RAC focus-visible", () => {
    expect(FOCUS_RING).toContain("outline-none");
    expect(FOCUS_RING).toContain("data-[focus-visible]:ring-2");
    expect(FOCUS_RING).toContain("data-[focus-visible]:ring-accent");
  });

  it("offers the same ring for native :focus-visible", () => {
    expect(FOCUS_RING_NATIVE).toContain("focus-visible:ring-2");
    expect(FOCUS_RING_NATIVE).toContain("focus-visible:ring-accent");
  });
});
