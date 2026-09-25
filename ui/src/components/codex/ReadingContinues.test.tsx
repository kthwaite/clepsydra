import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadingContinues } from "./ReadingContinues";

const ROW = {
  id: "b1",
  path: "books/ctesibius.md",
  title: "Ctesibius and the constant head",
  author: "Hero of Alexandria",
  progress: 40,
  pages: 100,
};

describe("ReadingContinues", () => {
  it("lists books as serif titles over a sink progress track, without rules", () => {
    const { container } = render(
      <ReadingContinues rows={[ROW]} onOpen={vi.fn()} onAdvance={vi.fn()} />,
    );
    expect(screen.getByText("Ctesibius and the constant head")).toHaveClass(
      "font-serif",
    );
    expect(
      screen.getByRole("heading", { name: "Reading continues" }),
    ).toHaveClass("font-serif", "italic");
    const track = container.querySelector("[data-progress-track]");
    expect(track).toHaveClass("bg-sink");
    expect(container.innerHTML).not.toMatch(/border-rule|uppercase/);
  });
});
