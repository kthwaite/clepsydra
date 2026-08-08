import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import Guide, { meta } from "#/docs/content/getting-started.mdx";
import source from "#/docs/content/getting-started.mdx?raw";
import Configuration from "#/docs/content/configuration.mdx";

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

it("renders repository-only guide references as non-clickable source paths", () => {
  render(<Configuration />);

  expect(screen.getByText("docs/encrypted-notes.md")).toHaveProperty(
    "tagName",
    "CODE",
  );
  expect(
    screen.queryByRole("link", { name: "encrypted-notes.md" }),
  ).not.toBeInTheDocument();
});
