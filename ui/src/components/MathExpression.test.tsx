import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MathExpression, renderMathToHtml } from "#/components/MathExpression";

describe("renderMathToHtml", () => {
  it("returns combined visual HTML and accessible MathML", () => {
    const result = renderMathToHtml("x^2", false);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected valid TeX to render");
    expect(result.html).toContain('class="katex-html"');
    expect(result.html).toContain("<math");
  });

  it("returns a discriminated failure without KaTeX error prose", () => {
    expect(renderMathToHtml(String.raw`\notACommand{`, false)).toEqual({
      ok: false,
    });
  });
});

describe("MathExpression", () => {
  it("renders inline visual output with accessible MathML", () => {
    const { container } = render(
      <MathExpression tex="x^2" delimiter="$" display={false} />,
    );

    const wrapper = container.querySelector("span.folio-math");
    expect(wrapper).toBeTruthy();
    expect(wrapper).not.toHaveClass("folio-math--display");
    expect(screen.getByText("x", { selector: ".katex-html *" })).toBeTruthy();
    expect(container.querySelector("math")).toBeTruthy();
    expect(container.querySelector(".katex-html")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("renders display math in a display wrapper", () => {
    const { container } = render(
      <MathExpression tex="x^2" delimiter="$$" display />,
    );

    const wrapper = container.querySelector("div.folio-math");
    expect(wrapper).toHaveClass("folio-math--display");
    expect(wrapper?.querySelector(".katex-display")).toBeTruthy();
  });

  it("preserves exact authored source for invalid TeX", () => {
    const authoredSource = String.raw`\(\notACommand{\)`;
    render(
      <MathExpression
        tex={String.raw`\notACommand{`}
        delimiter={"\\("}
        display={false}
      />,
    );

    const fallback = screen.getByText(authoredSource);
    expect(fallback).toHaveAttribute("aria-invalid", "true");
    expect(fallback).toHaveAttribute(
      "aria-label",
      "Invalid mathematical expression",
    );
    expect(fallback).toHaveClass("folio-math--invalid");
    expect(fallback).not.toHaveTextContent("KaTeX parse error");
  });

  it("activates an interactive expression when clicked", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const { container } = render(
      <MathExpression
        tex="x^2"
        delimiter="$"
        display={false}
        interactive
        onActivate={onActivate}
      />,
    );

    const wrapper = container.querySelector(".folio-math");
    expect(wrapper).toHaveClass("folio-math--interactive");
    expect(wrapper).toHaveAttribute("role", "button");
    expect(wrapper).toHaveAttribute("tabindex", "0");
    await user.click(wrapper!);
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("does not expose no-op button semantics without an activation handler", () => {
    const { container } = render(
      <MathExpression tex="x^2" delimiter="$" display={false} interactive />,
    );

    const wrapper = container.querySelector(".folio-math");
    expect(wrapper).not.toHaveClass("folio-math--interactive");
    expect(wrapper).not.toHaveAttribute("role");
    expect(wrapper).not.toHaveAttribute("tabindex");
  });

  it.each([
    String.raw`\href{javascript:alert(1)}{x}`,
    String.raw`\includegraphics{https://example.test/x}`,
  ])("does not activate trust-requiring TeX: %s", (tex) => {
    const { container } = render(
      <MathExpression tex={tex} delimiter="$" display={false} />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector(
        '[href^="http"], [href^="javascript:"], [src^="http"]',
      ),
    ).toBeNull();
  });
});
