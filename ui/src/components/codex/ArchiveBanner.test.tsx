import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ArchiveBanner } from "#/components/codex/ArchiveBanner";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { _splat?: string };
  }) => (
    <a href={to === "/pages/$" ? `/pages/${params?._splat}` : to} {...props}>
      {children}
    </a>
  ),
}));

const archive = {
  url: "https://example.com/articles/time",
  domain: "example.com",
  captured_at: "2026-08-12T14:05:00Z",
  content_hash: "content-hash",
  snapshot_hash: "snapshot-hash",
  source_hash: "source-hash",
  resource_count: 3,
};

describe("ArchiveBanner", () => {
  it("identifies the vault page, live origin, and capture time", () => {
    render(
      <ArchiveBanner
        title="The Shape of Time"
        path="archive/example/the-shape-of-time.md"
        archive={archive}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "The Shape of Time" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2026-08-12T14:05:00Z")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open live page/i })).toMatchObject(
      {
        href: "https://example.com/articles/time",
        target: "_blank",
        rel: "noreferrer",
      },
    );
    expect(
      screen.getByRole("link", { name: /back to vault page/i }),
    ).toHaveAttribute("href", "/pages/archive/example/the-shape-of-time.md");
  });

  it.each([
    ["https://example.com/articles/time", "https://example.com/articles/time"],
    ["http://example.com/articles/time", "http://example.com/articles/time"],
  ])("links an absolute HTTP(S) live URL: %s", (url, expectedHref) => {
    render(
      <ArchiveBanner
        title="The Shape of Time"
        path="archive/example/the-shape-of-time.md"
        archive={{ ...archive, url }}
      />,
    );

    expect(
      screen.getByRole("link", { name: /open live page/i }),
    ).toHaveAttribute("href", expectedHref);
  });

  it.each([
    "javascript:alert(document.domain)",
    "data:text/html,<h1>unsafe</h1>",
    "//example.com/protocol-relative",
    "not a URL",
  ])(
    "renders an invalid legacy archive URL as non-clickable corruption text: %s",
    (url) => {
      render(
        <ArchiveBanner
          title="The Shape of Time"
          path="archive/example/the-shape-of-time.md"
          archive={{ ...archive, url }}
        />,
      );

      expect(
        screen.queryByRole("link", { name: /open live page/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(url)).toBeInTheDocument();
      expect(
        screen.getByText(/invalid archive url metadata/i),
      ).toBeInTheDocument();
    },
  );

  it("shows optional provenance only when retained", () => {
    const { rerender } = render(
      <ArchiveBanner
        title="The Shape of Time"
        path="archive/example/the-shape-of-time.md"
        archive={{
          ...archive,
          site_name: "Example Review",
          byline: "Ada Lovelace",
          published_time: "2026-08-10T09:00:00Z",
        }}
      />,
    );

    expect(screen.getByText("Example Review")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("2026-08-10T09:00:00Z")).toBeInTheDocument();

    rerender(
      <ArchiveBanner
        title="The Shape of Time"
        path="archive/example/the-shape-of-time.md"
        archive={archive}
      />,
    );

    expect(screen.queryByText("Example Review")).not.toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-08-10T09:00:00Z")).not.toBeInTheDocument();
  });
});
