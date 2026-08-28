import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindIcon } from "#/components/KindIcon";
import { KINDS, kindColorVar } from "#/lib/kind";

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("Expected KindIcon to render an svg");
  return svg;
}

describe("KindIcon", () => {
  it("strokes the icon with the kind's colour var", () => {
    const { container } = render(<KindIcon kind="PERSON" />);

    expect(svgOf(container).getAttribute("stroke")).toBe(
      kindColorVar("PERSON"),
    );
  });

  it("renders a distinct lucide glyph per kind", () => {
    const glyphs = KINDS.map((kind) => {
      const { container } = render(<KindIcon kind={kind} />);
      return svgOf(container).getAttribute("class");
    });

    expect(new Set(glyphs).size).toBe(KINDS.length);
  });

  it("defaults to a 12px box and honours an explicit size", () => {
    const { container: dflt } = render(<KindIcon kind="NOTE" />);
    const { container: small } = render(<KindIcon kind="NOTE" size={11} />);

    expect(svgOf(dflt).getAttribute("width")).toBe("12");
    expect(svgOf(small).getAttribute("width")).toBe("11");
  });

  it("hides itself from assistive tech when unlabelled", () => {
    const { container } = render(<KindIcon kind="BOOK" />);

    const svg = svgOf(container);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("title")).toBeNull();
  });

  it("exposes a title as the accessible name when labelled", () => {
    const { container } = render(<KindIcon kind="BOOK" title="BOOK" />);

    const svg = svgOf(container);
    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.querySelector("title")?.textContent).toBe("BOOK");
  });

  it("merges caller classes onto the glyph", () => {
    const { container } = render(
      <KindIcon kind="NOTE" className="flex-shrink-0" />,
    );

    expect(svgOf(container).getAttribute("class")).toContain("flex-shrink-0");
  });
});
