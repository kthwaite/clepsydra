import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
