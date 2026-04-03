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
});
