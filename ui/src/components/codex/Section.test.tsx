import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Section } from "#/components/codex/Section";

describe("Section", () => {
  it("renders the eyebrow as a heading, caption and children", () => {
    render(
      <Section label="Recent" caption="2 of 2">
        <p>body</p>
      </Section>,
    );
    const heading = screen.getByRole("heading", { name: "Recent" });
    expect(heading).toHaveClass("font-serif", "italic");
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("omits the caption node when none is given", () => {
    const { container } = render(<Section label="Sky">x</Section>);
    expect(container.querySelector("[data-section-caption]")).toBeNull();
  });

  it.each([
    ["cool", "bg-accent", false],
    ["hot", "bg-accent", true],
    ["dim", "bg-faint", false],
  ] as const)("maps pip %s to a tick", (pip, bg, pulses) => {
    const { container } = render(
      <Section label="L" pip={pip}>
        x
      </Section>,
    );
    const tick = container.querySelector("[data-tick]");
    expect(tick).toHaveClass(bg);
    expect(tick?.classList.contains("animate-pulse")).toBe(pulses);
  });

  it("indents the body to the eyebrow unless tight", () => {
    const { rerender } = render(<Section label="L">x</Section>);
    expect(screen.getByText("x").closest("[data-section-body]")).toHaveClass(
      "pl-[19px]",
    );
    rerender(
      <Section label="L" tight>
        x
      </Section>,
    );
    expect(
      screen.getByText("x").closest("[data-section-body]"),
    ).not.toHaveClass("pl-[19px]");
  });

  it("has no border, band or fill", () => {
    const { container } = render(<Section label="L">x</Section>);
    const section = container.querySelector("section");
    expect(section?.className ?? "").not.toMatch(/border|bg-/);
  });
});
