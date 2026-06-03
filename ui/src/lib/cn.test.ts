import { describe, expect, it } from "vitest";
import { cn } from "#/lib/cn";

describe("cn", () => {
  it("merges class strings", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("deduplicates conflicting utilities via twMerge", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("handles conditional values via clsx", () => {
    expect(cn("base", false && "never", "extra")).toBe("base extra");
  });

  it("handles undefined and null", () => {
    expect(cn("base", undefined, null, "extra")).toBe("base extra");
  });

  it("merges semantic color tokens", () => {
    expect(cn("bg-primary", "bg-accent")).toBe("bg-accent");
  });
});
