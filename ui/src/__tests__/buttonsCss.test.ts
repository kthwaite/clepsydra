import { describe, expect, it } from "vitest";
import { prop, rule } from "./css-contract";

describe(".cl-btn stopgap (phase 3; call sites migrate to <Button> in phase 5)", () => {
  it("reads as a quiet button: sink fill, 14px radius, sentence case", () => {
    const btn = rule(".cl-btn");
    expect(prop(btn, "text-transform")).toBe("none");
    expect(prop(btn, "letter-spacing")).toBe("normal");
    expect(prop(btn, "border")).toBe("0");
    expect(prop(btn, "border-radius")).toBe("14px");
    expect(prop(btn, "background")).toBe("var(--sink)");
  });

  it("reads .cl-btn-hot as the primary cobalt pill", () => {
    const hot = rule(".cl-btn-hot");
    expect(prop(hot, "background")).toBe("var(--accent)");
    expect(prop(hot, "color")).toBe("var(--raise)");
    expect(prop(hot, "border-radius")).toBe("9999px");
  });
});
