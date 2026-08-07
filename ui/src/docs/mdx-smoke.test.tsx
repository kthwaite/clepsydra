import { render, screen } from "@testing-library/react";
import Guide, { meta } from "#/docs/content/getting-started.mdx";
import source from "#/docs/content/getting-started.mdx?raw";

it("compiles MDX, preserves typed metadata, and exposes raw source", () => {
  render(<Guide />);
  expect(screen.getByRole("heading", { name: "Getting Started" })).toHaveAttribute(
    "id",
    "getting-started",
  );
  expect(meta.slug).toBe("getting-started");
  expect(source).toContain("Create your first Clepsydra vault.");
});
