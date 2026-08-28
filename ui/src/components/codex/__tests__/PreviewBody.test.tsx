import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PagePreviewField, PagePreviewProjection } from "#/api/bases";
import { PreviewBody } from "#/components/codex/PreviewBody";

vi.mock("#/components/codex/PreviewMarkdown", () => ({
  PreviewMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const page = {
  meta: { title: "On Water Clocks", tags: ["history", "horology"] },
  body: "The clepsydra measured flowing time.",
};

function field(
  key: string,
  overrides: Partial<PagePreviewField> = {},
): PagePreviewField {
  return {
    key,
    label: key,
    present: true,
    value: `${key} value`,
    schema_conflict: false,
    label_conflict: false,
    sources: [{ base: { slug: "library", name: "Library" }, label: key }],
    ...overrides,
  };
}

function projection(
  fields: PagePreviewField[],
  remaining_count = 0,
): PagePreviewProjection {
  return { fields, remaining_count };
}

describe("PreviewBody", () => {
  it("retains title, excerpt, counts, and tags around projected fields", async () => {
    render(
      <PreviewBody
        path="notes/water-clocks.md"
        page={page}
        backlinks={[{}, {}]}
        preview={projection([field("status", { label: "Reading status" })])}
        showTags
      />,
    );

    expect(screen.getByText("On Water Clocks")).toBeInTheDocument();
    expect(
      await screen.findByText("The clepsydra measured flowing time."),
    ).toBeInTheDocument();
    expect(screen.getByText(/5 wd/)).toHaveTextContent("5 wd · ↘2");
    expect(screen.getByText("Reading status")).toBeInTheDocument();
    expect(screen.getByText("#history #horology")).toBeInTheDocument();
  });

  it("distinguishes missing values, explicit null, and ordered arrays", () => {
    render(
      <PreviewBody
        path="notes/values.md"
        page={page}
        preview={projection([
          field("missing", { present: false, value: null }),
          field("nullable", { value: null }),
          field("topics", { value: ["history", "time", 3] }),
        ])}
      />,
    );

    expect(screen.getByText("missing").nextElementSibling).toHaveTextContent(
      "—",
    );
    expect(screen.getByText("nullable").nextElementSibling).toHaveTextContent(
      "null",
    );
    expect(screen.getByText("topics").nextElementSibling).toHaveTextContent(
      "history, time, 3",
    );
  });

  it("renders body as a spanning, bounded row after the Markdown excerpt", async () => {
    const { container } = render(
      <PreviewBody
        path="notes/body.md"
        page={page}
        preview={projection([
          field("body", {
            label: "Summary",
            value: "A bounded plain-text body excerpt from the server.",
          }),
        ])}
      />,
    );

    const markdown = await screen.findByText(
      "The clepsydra measured flowing time.",
    );
    const definitionList = container.querySelector("dl");
    expect(definitionList).not.toBeNull();
    expect(
      markdown.compareDocumentPosition(definitionList as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Summary")).toHaveClass("col-span-2");
    expect(
      screen.getByText("A bounded plain-text body excerpt from the server."),
    ).toHaveClass("col-span-2", "line-clamp-2");
  });

  it("exposes label and schema conflict explanations without replacing values", () => {
    render(
      <PreviewBody
        path="notes/conflicts.md"
        page={page}
        preview={projection([
          field("status", {
            value: "reading",
            label_conflict: true,
            schema_conflict: true,
          }),
        ])}
      />,
    );

    expect(screen.getByText("reading")).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "Label conflict: matching Bases disagree, so the stored key is shown.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "Schema conflict: matching Bases declare incompatible field schemas.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the authoritative remainder count", () => {
    render(
      <PreviewBody
        path="notes/more.md"
        page={page}
        preview={projection([field("status")], 5)}
      />,
    );

    expect(screen.getByText("+5 more")).toBeInTheDocument();
  });

  it("keeps loading and empty projections passive but reports failure", () => {
    const { rerender } = render(
      <PreviewBody path="notes/passive.md" page={page} previewPending />,
    );
    expect(
      screen.queryByText("Properties unavailable"),
    ).not.toBeInTheDocument();
    expect(document.querySelector("dl")).toBeNull();

    rerender(
      <PreviewBody
        path="notes/passive.md"
        page={page}
        preview={projection([])}
      />,
    );
    expect(document.querySelector("dl")).toBeNull();

    rerender(<PreviewBody path="notes/passive.md" page={page} previewError />);
    expect(screen.getByText("Properties unavailable")).toBeInTheDocument();
  });

  it("never reveals projected values or failure state for protected pages", () => {
    render(
      <PreviewBody
        path="notes/private.md"
        page={{ ...page, encrypted: true }}
        preview={projection([field("secret", { value: "classified" })], 2)}
        previewError
      />,
    );

    expect(
      screen.getByText("Protected note · open to unlock"),
    ).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.queryByText("classified")).not.toBeInTheDocument();
    expect(screen.queryByText("+2 more")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Properties unavailable"),
    ).not.toBeInTheDocument();
  });
});
