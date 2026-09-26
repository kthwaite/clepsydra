import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { createEditor, type Descendant } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it, vi } from "vitest";
import {
  BaseEmbedEditingProvider,
  useBaseEmbedEditingController,
} from "#/editor/baseEmbedEditing";
import { slateToMarkdown } from "#/editor/convert";
import type { ValidGeneratedRegionElement } from "#/editor/schema/types";
import { withSchema } from "#/editor/schema/withSchema";
import { renderElement } from "./renderElement";

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

const abcHash =
  "blake3:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";
function region(payload: string): ValidGeneratedRegionElement {
  const rawBlock = `<!-- clep:generated\nversion = 1\nid = "99a65a82-e7a5-4714-b230-139a0e15bcf8"\nbase = "missing-base"\ntemplate = "missing-template"\noutput_hash = "${abcHash}"\n-->${payload}<!-- /clep:generated -->`;
  return {
    type: "generated-region",
    status: "valid",
    rawBlock,
    payload,
    descriptor: {
      version: 1,
      id: "99a65a82-e7a5-4714-b230-139a0e15bcf8",
      base: "missing-base",
      template: "missing-template",
      output_hash: abcHash,
    },
    children: [{ text: "" }],
  };
}

function SnapshotHarness({ value }: { value: Descendant[] }) {
  const [editor] = useState(() => withReact(withSchema(createEditor())));
  const [body, setBody] = useState("");
  const editing = useBaseEmbedEditingController(editor);
  return (
    <Slate editor={editor} initialValue={value}>
      <BaseEmbedEditingProvider value={editing}>
        <Editable renderElement={renderElement} />
        <button
          type="button"
          onClick={() => setBody(slateToMarkdown(editor.children))}
        >
          Read document
        </button>
        <output>{body}</output>
      </BaseEmbedEditingProvider>
    </Slate>
  );
}

describe("stored generated region interaction", () => {
  it("reads a saved snapshot without a page lifecycle or available Base/template and detects exact-byte external edits", () => {
    const { rerender } = render(<SnapshotHarness value={[region("abc")]} />);
    expect(screen.getByText("abc")).toBeVisible();
    expect(screen.queryByText(/was modified outside regeneration/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Preview / Regenerate" }),
    ).toBeDisabled();
    rerender(<SnapshotHarness key="external-edit" value={[region("abc\n")]} />);
    expect(screen.getByText("abc")).toBeVisible();
    expect(screen.getByText(/was modified outside regeneration/)).toBeVisible();
  });

  it("removes only the whole selected snapshot and preserves neighboring handwritten paragraphs", () => {
    render(
      <SnapshotHarness
        value={[
          { type: "paragraph", children: [{ text: "Before the snapshot." }] },
          region("abc"),
          { type: "paragraph", children: [{ text: "After the snapshot." }] },
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove generated region" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Read document" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Before the snapshot. After the snapshot.",
    );
    expect(screen.queryByTestId("generated-region")).toBeNull();
  });

  it("keeps the repair source monospace as a code editor", () => {
    const broken = {
      type: "generated-region",
      status: "invalid",
      rawBlock: "<!-- clep:generated\nnot toml\n-->x<!-- /clep:generated -->",
      parseError: "bad descriptor",
      children: [{ text: "" }],
    } as unknown as Descendant;
    render(<SnapshotHarness value={[broken]} />);
    fireEvent.click(screen.getByRole("button", { name: "Repair source" }));
    expect(
      screen.getByRole("textbox", { name: "Generated region Markdown" }),
    ).toHaveAttribute("data-code-editor");
  });
});
