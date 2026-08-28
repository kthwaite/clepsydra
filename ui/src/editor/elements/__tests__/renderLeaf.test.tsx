import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLeaf } from "../renderLeaf";

function leaf(marks: Record<string, unknown>, text = "hello") {
  const props = {
    attributes: { "data-slate-leaf": true } as any,
    children: <span>{text}</span>,
    leaf: { text, ...marks } as any,
    text: { text, ...marks } as any,
  };
  return renderLeaf(props);
}

describe("renderLeaf", () => {
  it("renders strikethrough with del tag", () => {
    const { container } = render(leaf({ strikethrough: true }));
    expect(container.querySelector("del")).not.toBeNull();
    expect(container.textContent).toBe("hello");
  });

  it("renders combined bold + strikethrough", () => {
    const { container } = render(leaf({ bold: true, strikethrough: true }));
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("del")).not.toBeNull();
  });

  it("code + strikethrough both render in the leaf", () => {
    const { container } = render(leaf({ code: true, strikethrough: true }));
    expect(container.querySelector("code")).not.toBeNull();
    expect(container.querySelector("del")).not.toBeNull();
  });

  it("opts inline code out of spellcheck", () => {
    const { container } = render(leaf({ code: true }));
    expect(container.querySelector("code")).toHaveAttribute(
      "spellcheck",
      "false",
    );
  });

  it("renders underline with u tag", () => {
    const { container } = render(leaf({ underline: true }));
    expect(container.querySelector("u")).not.toBeNull();
    expect(container.textContent).toBe("hello");
  });

  it("renders combined bold + underline", () => {
    const { container } = render(leaf({ bold: true, underline: true }));
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("u")).not.toBeNull();
  });

  it("renders superscript with sup tag", () => {
    const { container } = render(leaf({ superscript: true }));
    expect(container.querySelector("sup")).not.toBeNull();
    expect(container.textContent).toBe("hello");
  });

  it("renders subscript with sub tag", () => {
    const { container } = render(leaf({ subscript: true }));
    expect(container.querySelector("sub")).not.toBeNull();
    expect(container.textContent).toBe("hello");
  });

  it("colours a known token leaf with its mapped CSS var", () => {
    const { container } = render(leaf({ token: "keyword" }));
    const span = container.querySelector("span[style]");
    expect(span?.getAttribute("style")).toContain("var(--cool)");
  });

  it("falls back to inherit for an unknown token type", () => {
    const { container } = render(leaf({ token: "not-a-real-token" }));
    const span = container.querySelector("span[style]");
    expect(span?.getAttribute("style")).toContain("inherit");
  });
});
