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
  {
    id: "property-system-prefixed-title",
    key: "sys.title",
    definition: { type: "text" },
  },
  {
    id: "property-system-prefixed-custom",
    key: "sys.custom",
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
    expect(
      within(select).getByRole("option", { name: "sys.title" }),
    ).toHaveValue("prop.sys.title");
    expect(
      within(select).getByRole("option", { name: "sys.custom" }),
    ).toHaveValue("prop.sys.custom");
    expect(screen.getByText(/markdown body is read-only/i)).toBeInTheDocument();
  });

  it("changes a row field in place, preserves its metadata and focus, and disables canonical duplicates", async () => {
    const user = userEvent.setup();
    const changes = renderEditor([
      {
        id: "preview-system-title",
        field: "sys.title",
        label: "Headline",
      },
      { id: "preview-qualified-body", field: "prop.body", label: "Excerpt" },
    ]);

    const field = screen.getByLabelText(
      "Field for preview property sys.title",
    );
    expect(
      within(field).getByRole("option", { name: /body.*already added/i }),
    ).toBeDisabled();
    expect(
      within(field).getByRole("option", { name: "Property title" }),
    ).toBeEnabled();

    await user.selectOptions(field, "status");

    const changedField = screen.getByLabelText(
      "Field for preview property status",
    );
    expect(changedField).toHaveFocus();
    expect(changes).toHaveBeenLastCalledWith([
      {
        id: "preview-system-title",
        field: "status",
        label: "Headline",
      },
      { id: "preview-qualified-body", field: "prop.body", label: "Excerpt" },
    ]);
    expect(screen.getByLabelText("Label for status")).toHaveValue("Headline");
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
    expect(label).toHaveFocus();
    expect(label).toBeEnabled();
    await user.type(label, "Reading state");

    const moveUp = screen.getByRole("button", { name: "Move status up" });
    moveUp.focus();
    await user.click(moveUp);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Moved status to position 1 of 2.",
    );
    const enabledMove = screen.getByRole("button", {
      name: "Move status down",
    });
    expect(enabledMove).toHaveFocus();
    expect(enabledMove).toBeEnabled();
    expect(changes).toHaveBeenLastCalledWith([
      expect.objectContaining({ field: "status", label: "Reading state" }),
      expect.objectContaining({ field: "body", label: "Excerpt" }),
    ]);
    await user.click(enabledMove);
    const enabledMoveBack = screen.getByRole("button", {
      name: "Move status up",
    });
    expect(enabledMoveBack).toHaveFocus();
    expect(enabledMoveBack).toBeEnabled();


    await user.click(
      screen.getByRole("button", { name: "Remove preview property body" }),
    );
    expect(screen.queryByLabelText("Label for body")).toBeNull();
    expect(screen.getByLabelText("Label for status")).toHaveFocus();
    expect(screen.getByLabelText("Label for status")).toBeEnabled();
  });

  it("focuses the selector after removing the only preview row", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Remove preview property body" }),
    );

    expect(screen.getByLabelText("Preview property to add")).toHaveFocus();
    expect(screen.getByLabelText("Preview property to add")).toBeEnabled();
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
