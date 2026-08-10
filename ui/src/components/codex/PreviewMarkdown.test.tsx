import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreviewMarkdown } from "#/components/codex/PreviewMarkdown";

describe("PreviewMarkdown", () => {
  it("marks a recognized resource while keeping preview links non-interactive", () => {
    render(
      <PreviewMarkdown
        content="[Wikipedia](https://en.wikipedia.org/wiki/Hypertext)"
      />,
    );

    const text = screen.getByText("Wikipedia");
    expect(text.tagName).toBe("SPAN");
    expect(text).toHaveAttribute("data-link-resource", "wikipedia");
    expect(screen.queryByRole("link", { name: "Wikipedia" })).toBeNull();
  });

  it("renders both delimiter families as inline and display math", () => {
    const { container } = render(
      <PreviewMarkdown
        content={String.raw`Dollar inline $x^2$ and backslash inline \(y + 1\).

$$
z = x + y
$$

\[
w = z^2
\]`}
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(4);
    expect(
      container.querySelectorAll(
        "span.folio-math:not(.folio-math--display)",
      ),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll("div.folio-math--display"),
    ).toHaveLength(2);
  });

  it("preserves exact invalid source and excludes code from math rendering", () => {
    const source = String.raw`\(\notACommand{\)`;
    const { container } = render(
      <PreviewMarkdown
        content={`${source}\n\nInline code: \`$x$\`.\n\n\`\`\`tex\n$$\nx^2\n$$\n\`\`\``}
      />,
    );

    const fallback = container.querySelector(".folio-math--invalid");
    expect(fallback).toHaveTextContent(source);
    expect(fallback).not.toHaveTextContent("KaTeX parse error");
    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    expect(screen.getByText("$x$")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "CODE" &&
          element.textContent?.trim() === "$$\nx^2\n$$",
      ),
    ).toBeTruthy();
  });

  it("keeps raw HTML escaped and has no activation or network affordances", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rawHtml = '<input aria-label="edit math">';
    const { container } = render(
      <PreviewMarkdown
        content={`${String.raw`$x^2$`}\n\n[reference](https://example.test)\n\n![remote](https://example.test/math.png)\n\n${rawHtml}`}
      />,
    );

    const math = container.querySelector<HTMLElement>(".folio-math");
    expect(math).toBeTruthy();
    expect(math).not.toHaveClass("folio-math--interactive");
    expect(math).not.toHaveAttribute("role");
    expect(math).not.toHaveAttribute("tabindex");
    expect(math?.onclick).toBeNull();
    expect(math?.onkeydown).toBeNull();
    expect(container.querySelector("a, button, input, textarea, img")).toBeNull();
    expect(container).toHaveTextContent(rawHtml);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

});
