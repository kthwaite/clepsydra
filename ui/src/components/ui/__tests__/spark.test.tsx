import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spark } from "../spark";

describe("Spark", () => {
  it("renders an svg polyline with one point per datum", () => {
    const { container } = render(
      <Spark data={[1, 3, 2, 5]} width={96} height={26} accent="var(--cool)" />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("width", "96");
    expect(svg).toHaveAttribute("height", "26");

    const polyline = container.querySelector("polyline");
    expect(polyline).toBeInTheDocument();
    expect(polyline).toHaveAttribute("stroke", "var(--cool)");
    expect(polyline?.getAttribute("points")?.split(" ")).toHaveLength(4);
  });

  it("renders nothing for fewer than two data points", () => {
    const { container } = render(
      <Spark data={[7]} width={96} height={26} accent="var(--cool)" />,
    );
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });
});
