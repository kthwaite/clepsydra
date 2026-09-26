import { describe, expect, it } from "vitest";
import { prop, rule } from "./css-contract";

describe(".feed-entry-content reads as Stone & Lamp prose", () => {
  it("sets the body in 17px Geist on ink-2", () => {
    const body = rule(".feed-entry-content");
    expect(prop(body, "font-size")).toBe("17px");
    expect(prop(body, "line-height")).toBe("1.7");
    expect(prop(body, "color")).toBe("var(--ink-2)");
  });

  it("sets headings in the serif at regular weight", () => {
    const h = rule(".feed-entry-content :is(h1, h2, h3, h4, h5, h6)");
    expect(prop(h, "font-family")).toBe("var(--font-serif)");
    expect(prop(h, "font-weight")).toBe("400");
  });

  it("sets quotes as an italic serif panel on ground with no rule", () => {
    const q = rule(".feed-entry-content blockquote");
    expect(prop(q, "font-family")).toBe("var(--font-serif)");
    expect(prop(q, "background")).toBe("var(--ground)");
    expect(prop(q, "border-radius")).toBe("12px");
    expect(prop(q, "border-inline-start")).toBeUndefined();
  });

  it("uses Stone & Lamp roles, not Vessel variables, for links and code", () => {
    expect(
      prop(rule(".feed-entry-content a"), "text-decoration-color"),
    ).toBeUndefined();
    expect(
      prop(
        rule(".feed-entry-content a:is(:hover, :focus-visible)"),
        "background",
      ),
    ).toBe("var(--accent-tint)");
    expect(prop(rule(".feed-entry-content code"), "background")).toBe(
      "var(--sink)",
    );
  });

  it("draws no rule-coloured borders: pre on sink, tables and hr in faint", () => {
    const pre = rule(".feed-entry-content pre");
    expect(prop(pre, "border")).toBeUndefined();
    expect(prop(pre, "background")).toBe("var(--sink)");
    expect(prop(pre, "border-radius")).toBe("12px");
    expect(
      prop(rule(".feed-entry-content :is(th, td)"), "border"),
    ).toBeUndefined();
    expect(prop(rule(".feed-entry-content hr"), "border-top")).toBe(
      "1px solid var(--faint)",
    );
  });
});
