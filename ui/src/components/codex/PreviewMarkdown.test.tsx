import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreviewContext } from "#/components/codex/PreviewContext";
import { PreviewMarkdown } from "#/components/codex/PreviewMarkdown";
import { usePreviewStore } from "#/store/preview";

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/api/attachments", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAttachments: () => ({
    data: [{ vault_path: "media/report.pdf", path: "report.pdf" }],
  }),
}));

describe("PreviewMarkdown", () => {
  it("follows a relative note link from its containing page without opening a browser tab", () => {
    usePreviewStore.setState({ windows: [], topZ: 200 });
    const parent = usePreviewStore
      .getState()
      .open({ path: "notes/parent.md" }, new DOMRect(), { mode: "reader" });
    render(
      <PreviewContext value={parent}>
        <PreviewMarkdown
          pagePath="notes/parent.md"
          content="[Related](./related.md#Details)"
        />
      </PreviewContext>,
    );
    const link = screen.getByRole("link", { name: "Related" });
    expect(link).not.toHaveAttribute("target", "_blank");
    fireEvent.click(link);
    expect(usePreviewStore.getState().windows).toContainEqual(
      expect.objectContaining({
        path: "notes/related.md",
        heading: "Details",
        parentId: parent,
        mode: "reader",
      }),
    );
  });

  it("uses vault attachment and CAS endpoints rather than application-relative URLs", () => {
    render(
      <PreviewContext value="parent">
        <PreviewMarkdown
          pagePath="notes/parent.md"
          content="[Report](../media/report.pdf#page=2) and [Snapshot](cas:abcd/file.pdf)"
        />
      </PreviewContext>,
    );
    expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute(
      "href",
      "/api/vault/attachments/report.pdf#page=2",
    );
    expect(screen.getByRole("link", { name: "Snapshot" })).toHaveAttribute(
      "href",
      "/api/vault/cas/abcd/file.pdf",
    );
  });

  it("follows internal links as child readers only inside a preview", () => {
    usePreviewStore.setState({ windows: [], topZ: 200 });
    const parent = usePreviewStore
      .getState()
      .open({ path: "notes/parent.md" }, new DOMRect(), { mode: "reader" });
    render(
      <PreviewContext value={parent}>
        <PreviewMarkdown content="[Child](/pages/notes%2Fchild.md#Details) and [Outside](https://example.test)" />
      </PreviewContext>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Child" }));
    expect(usePreviewStore.getState().windows).toContainEqual(
      expect.objectContaining({
        path: "notes/child.md",
        heading: "Details",
        parentId: parent,
        mode: "reader",
      }),
    );
    expect(screen.getByRole("link", { name: "Outside" })).toHaveAttribute(
      "href",
      "https://example.test",
    );
  });

  it("marks a recognized resource while keeping preview links non-interactive", () => {
    render(
      <PreviewMarkdown content="[Wikipedia](https://en.wikipedia.org/wiki/Hypertext)" />,
    );

    const text = screen.getByText("Wikipedia");
    expect(text.tagName).toBe("SPAN");
    expect(text).toHaveAttribute("data-link-resource", "wikipedia");
    expect(screen.queryByRole("link", { name: "Wikipedia" })).toBeNull();
  });

  it("marks wikilinks with the wikilink mark", () => {
    render(<PreviewMarkdown content="See [[Other Page]]." />);

    expect(screen.getByText("Other Page")).toHaveAttribute(
      "data-link-resource",
      "wikilink",
    );
  });

  it("shows a wikilink alias as an inert wikilink span", () => {
    const { container } = render(
      <PreviewMarkdown content="See [[Target Page|the target]] and [[Target Page#Notes]]." />,
    );

    for (const name of ["the target", "Target Page#Notes"]) {
      const text = screen.getByText(name);
      expect(text.tagName).toBe("SPAN");
      expect(text).toHaveAttribute("data-link-resource", "wikilink");
    }
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("[node]")).toBeNull();
    expect(container.querySelector("[href]")).toBeNull();
  });

  it("marks prefixed external links with their resource", () => {
    render(<PreviewMarkdown content="[paper](arxiv:2301.00001)" />);

    expect(screen.getByText("paper")).toHaveAttribute(
      "data-link-resource",
      "arxiv",
    );
  });

  it("renders both delimiter families as inline and display math", () => {
    const { container } = render(
      <PreviewMarkdown
        content={String.raw`Dollar inline $x^2$ and backslash inline \(y + 1\).

$$
z = x + y
$$

\[
w = z^2
\]`}
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(4);
    expect(
      container.querySelectorAll("span.folio-math:not(.folio-math--display)"),
    ).toHaveLength(2);
    expect(container.querySelectorAll("div.folio-math--display")).toHaveLength(
      2,
    );
  });

  it("preserves exact invalid source and excludes code from math rendering", () => {
    const source = String.raw`\(\notACommand{\)`;
    const { container } = render(
      <PreviewMarkdown
        content={`${source}\n\nInline code: \`$x$\`.\n\n\`\`\`tex\n$$\nx^2\n$$\n\`\`\``}
      />,
    );

    const fallback = container.querySelector(".folio-math--invalid");
    expect(fallback).toHaveTextContent(source);
    expect(fallback).not.toHaveTextContent("KaTeX parse error");
    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    expect(screen.getByText("$x$")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "CODE" &&
          element.textContent?.trim() === "$$\nx^2\n$$",
      ),
    ).toBeTruthy();
  });

  it("keeps raw HTML escaped and has no activation or network affordances", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rawHtml = '<input aria-label="edit math">';
    const { container } = render(
      <PreviewMarkdown
        content={`$x^2$\n\n[reference](https://example.test)\n\n![remote](https://example.test/math.png)\n\n${rawHtml}`}
      />,
    );

    const math = container.querySelector<HTMLElement>(".folio-math");
    expect(math).toBeTruthy();
    expect(math).not.toHaveClass("folio-math--interactive");
    expect(math).not.toHaveAttribute("role");
    expect(math).not.toHaveAttribute("tabindex");
    expect(math?.onclick).toBeNull();
    expect(math?.onkeydown).toBeNull();
    expect(
      container.querySelector("a, button, input, textarea, img"),
    ).toBeNull();
    expect(container).toHaveTextContent(rawHtml);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
