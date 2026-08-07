import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import Guide, { meta } from "#/docs/content/getting-started.mdx";
import source from "#/docs/content/getting-started.mdx?raw";

it("compiles MDX, preserves typed metadata, and exposes raw source", () => {
  render(<Guide />);
  expect(screen.getByRole("heading", { name: "Prerequisites" })).toHaveAttribute(
    "id",
    "prerequisites",
  );
  expect(meta.slug).toBe("getting-started");
  expect(source).toContain(
    "This guide gets Clepsydra running locally with an initialized vault.",
  );
});
