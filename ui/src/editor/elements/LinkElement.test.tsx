import { render, screen } from "@testing-library/react";
import type { RenderElementProps } from "slate-react";
import { describe, expect, it, vi } from "vitest";
import { LinkElement } from "#/editor/elements/LinkElement";
import type { LinkElement as LinkElementType } from "#/editor/types";

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => vi.fn(),
}));

const attributes = {
  "data-slate-node": "element",
  "data-slate-inline": true,
  ref: () => {},
} as unknown as RenderElementProps["attributes"];

function renderLink(url: string) {
  const element: LinkElementType = {
    type: "link",
    url,
    children: [{ text: "Wikipedia" }],
  };
  render(
    <LinkElement attributes={attributes} element={element}>
      Wikipedia
    </LinkElement>,
  );
  return screen.getByText("Wikipedia");
}

describe("LinkElement resource marks", () => {
  it("marks a recognized URL without adding editable or accessible text", () => {
    const link = renderLink("https://en.wikipedia.org/wiki/Hypertext");
    expect(link).toHaveAttribute("data-link-resource", "wikipedia");
    expect(link).toHaveTextContent(/^Wikipedia$/);
    expect(link.childNodes).toHaveLength(1);
  });

  it("does not mark a vault-relative link", () => {
    const link = renderLink("notes/local.md");
    expect(link).not.toHaveAttribute("data-link-resource");
    expect(link).not.toHaveAttribute("href");
  });

  it("exposes a CAS link through the vault blob endpoint", () => {
    const link = renderLink("cas:sha256:abc123");
    expect(link).toHaveAttribute("href", "/api/vault/cas/sha256:abc123");
  });
});
