import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  DraftPreviewField,
  DraftProperty,
} from "#/components/bases/definition-model";
import { PreviewPropertiesEditor } from "#/components/bases/PreviewPropertiesEditor";

const properties: DraftProperty[] = [
  {
    id: "property-status",
    key: "status",
    definition: { type: "select", options: ["queued", "reading"] },
  },
  {
    id: "property-title",
    key: "title",
    definition: { type: "text" },
  },
  {
    id: "property-prefixed-title",
    key: "prop.title",
    definition: { type: "text" },
  },
];

function renderEditor(
  initial: DraftPreviewField[] = [
    { id: "preview-body", field: "body", label: "Excerpt" },
  ],
  registerFocus = vi.fn(),
) {
  const changes = vi.fn<(preview: DraftPreviewField[]) => void>();
  function Harness() {
    const [preview, setPreview] = useState(initial);
    return (
      <PreviewPropertiesEditor
        preview={preview}
        properties={properties}
        diagnostics={[]}
        onChange={(next) => {
          changes(next);
          setPreview(next);
        }}
        registerFocus={registerFocus}
      />
    );
  }
  render(<Harness />);
  return changes;
}

describe("PreviewPropertiesEditor", () => {
  it("offers body once as read-only and disables duplicate canonical choices with reasons", () => {
    renderEditor([
      { id: "preview-system-title", field: "sys.title" },
      { id: "preview-body", field: "body" },
    ]);

    const select = screen.getByLabelText("Preview property to add");
    expect(
      within(select).getAllByRole("option", { name: /body.*read-only/i }),
    ).toHaveLength(1);
    expect(
      within(select).getByRole("option", { name: /system title.*already added/i }),
    ).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: /body.*already added/i }),
    ).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: "prop.title" }),
    ).toHaveValue("prop.prop.title");
    expect(screen.getByText(/markdown body is read-only/i)).toBeInTheDocument();
  });

  it("adds, labels, reorders, announces, preserves focus, and removes preview rows", async () => {
    const user = userEvent.setup();
    const changes = renderEditor();

    await user.selectOptions(
      screen.getByLabelText("Preview property to add"),
      "status",
    );
    await user.click(screen.getByRole("button", { name: "Add preview property" }));
    const label = screen.getByLabelText("Label for status");
    await user.type(label, "Reading state");

    const moveUp = screen.getByRole("button", { name: "Move status up" });
    moveUp.focus();
    await user.click(moveUp);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Moved status to position 1 of 2.",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Move status up" }),
    );
    expect(changes).toHaveBeenLastCalledWith([
      expect.objectContaining({ field: "status", label: "Reading state" }),
      expect.objectContaining({ field: "body", label: "Excerpt" }),
    ]);

    await user.click(
      screen.getByRole("button", { name: "Remove preview property body" }),
    );
    expect(screen.queryByLabelText("Label for body")).toBeNull();
  });

  it("registers exact field and label diagnostic focus targets", () => {
    const registerFocus = vi.fn();
    renderEditor(undefined, registerFocus);

    expect(registerFocus).toHaveBeenCalledWith(
      "preview[0].field",
      expect.any(HTMLElement),
    );
    expect(registerFocus).toHaveBeenCalledWith(
      "preview[0].label",
      expect.any(HTMLElement),
    );
  });
});
