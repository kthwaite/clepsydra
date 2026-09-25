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

describe("Section compact", () => {
  it("draws a smaller muted eyebrow and a 17px body indent for rails", () => {
    const { container } = render(
      <Section label="On this page" compact>
        <p>body</p>
      </Section>,
    );
    const heading = screen.getByRole("heading", { name: "On this page" });
    expect(heading).toHaveClass("text-[18px]", "text-mute");
    expect(heading).not.toHaveClass("text-[22px]");
    expect(container.querySelector("[data-section-body]")).toHaveClass(
      "pl-[17px]",
    );
  });

  it("keeps the default eyebrow at 22px ink", () => {
    render(
      <Section label="Recent">
        <p>body</p>
      </Section>,
    );
    expect(screen.getByRole("heading", { name: "Recent" })).toHaveClass(
      "text-[22px]",
      "text-ink",
    );
  });
});
