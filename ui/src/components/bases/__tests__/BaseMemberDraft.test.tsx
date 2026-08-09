import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BaseMemberDraft } from "#/components/bases/BaseMemberDraft";
import type { BaseMemberDraftField } from "#/components/bases/member-draft";

const fields: BaseMemberDraftField[] = [
  {
    key: "title",
    kind: "title",
    membership: true,
    viewOnly: false,
  },
  {
    key: "kind",
    kind: "kind",
    membership: true,
    viewOnly: false,
  },
  {
    key: "project",
    kind: "project",
    membership: false,
    viewOnly: true,
  },
  {
    key: "tags",
    kind: "tags",
    membership: false,
    viewOnly: false,
  },
  {
    key: "aliases",
    kind: "aliases",
    membership: false,
    viewOnly: false,
  },
  {
    key: "rating",
    kind: "property",
    definition: { type: "number" },
    membership: false,
    viewOnly: false,
  },
  {
    key: "status",
    kind: "property",
    definition: { type: "select", options: ["unread", "read"] },
    membership: false,
    viewOnly: true,
  },
];

type DraftProps = Parameters<typeof BaseMemberDraft>[0];

function draftElement(overrides: Partial<DraftProps> = {}) {
  return (
    <BaseMemberDraft
      fields={fields}
      projects={["clepsydra", "vessel"]}
      isSaving={false}
      diagnostics={[]}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      {...overrides}
    />
  );
}

describe("BaseMemberDraft", () => {
  it("focuses title, preserves native values, and submits the complete draft", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(draftElement({ onSave }));

    const title = screen.getByRole("textbox", { name: "New member — Title" });
    expect(title).toHaveFocus();
    await user.type(title, "The Dispossessed");
    await user.type(
      screen.getByRole("textbox", { name: "New member — Tags" }),
      "anarchism{Enter}",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "New member — Rating" }),
      "9",
    );
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    expect(onSave).toHaveBeenCalledWith({
      title: "The Dispossessed",
      fields: {
        kind: "NOTE",
        tags: ["anarchism"],
        aliases: [],
        rating: 9,
      },
    });
  });

  it("gives every field a stable name and describes filter requirements", () => {
    render(draftElement());

    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveAccessibleDescription("Required for base membership.");
    expect(
      screen.getByRole("button", { name: "New member — Kind" }),
    ).toHaveAccessibleDescription("Required for base membership.");
    expect(
      screen.getByRole("combobox", { name: "New member — Project" }),
    ).toHaveAccessibleDescription("Required for the active view.");
    expect(
      screen.getByRole("textbox", { name: "New member — Tags" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "New member — Aliases" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit New member — Status" }),
    ).toHaveAccessibleDescription("Required for the active view.");
  });

  it("associates diagnostics, announces the row error, and focuses the first invalid field", () => {
    const { rerender } = render(draftElement());
    rerender(
      draftElement({
        diagnostics: [
          {
            scope: "view",
            field: "status",
            filter_path: "views.Unread.filter",
            message: "status must equal unread",
          },
        ],
        summaryError: "Candidate does not match the active view",
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Candidate does not match the active view",
    );
    const status = screen.getByRole("button", {
      name: "Edit New member — Status",
    });
    expect(status).toHaveFocus();
    expect(status).toHaveAccessibleDescription(
      "Required for the active view. status must equal unread",
    );
  });

  it("blocks a blank title locally and focuses its named error", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(draftElement({ onSave }));

    await user.click(screen.getByRole("button", { name: "Save new member" }));

    expect(onSave).not.toHaveBeenCalled();
    const title = screen.getByRole("textbox", { name: "New member — Title" });
    expect(title).toHaveFocus();
    expect(title).toHaveAccessibleDescription(
      "Required for base membership. Title is required.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Title is required.");
  });

  it("disables all draft actions and fields while saving", () => {
    render(draftElement({ isSaving: true }));

    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "New member — Kind" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "New member — Project" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save new member" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Cancel new member" }),
    ).toBeDisabled();
  });

  it("uses command-enter and control-enter to save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(draftElement({ onSave }));
    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "A Book",
    );

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("lets an active property editor consume Escape before the row cancels", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(draftElement({ onCancel }));

    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("lets normal editor Enter commit without saving the row", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(draftElement({ onSave }));
    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "A Book",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "New member — Rating" }),
      "7{Enter}",
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    ).toHaveTextContent("7");
  });

  it("preserves the draft when a rejected save returns diagnostics", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(draftElement({ onSave }));
    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "Still Here",
    );
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    rerender(
      draftElement({
        onSave,
        diagnostics: [
          { scope: "field", field: "title", message: "title is not unique" },
        ],
        summaryError: "Could not create member",
      }),
    );

    expect(
      screen.getByRole("textbox", { name: "New member — Title" }),
    ).toHaveValue("Still Here");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not create member",
    );
  });
});
