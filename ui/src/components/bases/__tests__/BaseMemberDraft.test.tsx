import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BaseDetailResponse, BaseMemberCapability } from "#/api/bases";
import { BaseMemberDraft } from "#/components/bases/BaseMemberDraft";
import {
  type BaseMemberDraftField,
  composeMemberDraftFields,
} from "#/components/bases/member-draft";

const fields: BaseMemberDraftField[] = [
  {
    key: "title",
    kind: "title",
    membership: true,
    viewOnly: false,
    embedOnly: false,
  },
  {
    key: "kind",
    kind: "kind",
    membership: true,
    viewOnly: false,
    embedOnly: false,
  },
  {
    key: "project",
    kind: "project",
    membership: false,
    viewOnly: true,
    embedOnly: false,
  },
  {
    key: "tags",
    kind: "tags",
    membership: false,
    viewOnly: false,
    embedOnly: false,
  },
  {
    key: "aliases",
    kind: "aliases",
    membership: false,
    viewOnly: false,
    embedOnly: false,
  },
  {
    key: "rating",
    kind: "property",
    definition: { type: "number" },
    membership: false,
    viewOnly: false,
    embedOnly: true,
  },
  {
    key: "status",
    kind: "property",
    definition: { type: "select", options: ["unread", "read"] },
    membership: false,
    viewOnly: true,
    embedOnly: true,
  },
];

type DraftProps = Parameters<typeof BaseMemberDraft>[0];

function draftElement(overrides: Partial<DraftProps> = {}) {
  return (
    <BaseMemberDraft
      fields={fields}
      projects={["clepsydra", "vessel"]}
      isSaving={false}
      isSaveDisabled={false}
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

  it("explains a value the Base fixes and one it narrows to a set", () => {
    render(
      draftElement({
        fields: [
          {
            key: "kind",
            kind: "kind",
            membership: true,
            viewOnly: false,
            embedOnly: false,
            implied: { kind: "fixed", value: "BOOK" },
          },
          {
            key: "status",
            kind: "property",
            definition: { type: "select", options: ["queued", "reading"] },
            membership: true,
            viewOnly: false,
            embedOnly: false,
            implied: { kind: "choice", values: ["queued", "reading"] },
          },
        ],
      }),
    );

    expect(
      screen.getByText(/required for base membership\. the base fixes this to BOOK/i),
    ).toBeVisible();
    expect(
      screen.getByText(/required for base membership\. the base allows queued or reading/i),
    ).toBeVisible();
  });

  it("offers only the values a choice allows", async () => {
    const user = userEvent.setup();
    render(
      draftElement({
        fields: [
          {
            key: "status",
            kind: "property",
            definition: {
              type: "select",
              options: ["queued", "reading", "finished"],
            },
            membership: true,
            viewOnly: false,
            embedOnly: false,
            implied: { kind: "choice", values: ["queued", "reading"] },
          },
        ],
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Edit New member — Status" }),
    );
    await user.click(
      screen.getByRole("button", { name: /—.*New member — Status/ }),
    );
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent),
      // The leading em dash is the select's own clear option.
    ).toEqual(["—", "queued", "reading"]);
  });

  it("proposes a title from the Base's template until the author writes one", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      draftElement({
        onSave,
        titleTemplate: "{author} — {work}",
        fields: [
          {
            key: "title",
            kind: "title",
            membership: false,
            viewOnly: false,
            embedOnly: false,
          },
          {
            key: "author",
            kind: "property",
            definition: { type: "text" },
            membership: false,
            viewOnly: false,
            embedOnly: false,
          },
          {
            key: "work",
            kind: "property",
            definition: { type: "text" },
            membership: false,
            viewOnly: false,
            embedOnly: false,
          },
        ],
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Edit New member — Author" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "New member — Author" }),
      "Le Guin{Enter}",
    );

    const title = screen.getByRole("textbox", { name: "New member — Title" });
    expect(title).toHaveValue("Le Guin");

    await user.click(
      screen.getByRole("button", { name: "Edit New member — Work" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "New member — Work" }),
      "The Dispossessed{Enter}",
    );
    expect(title).toHaveValue("Le Guin — The Dispossessed");

    // Once the author writes a title, the template stops overwriting it.
    await user.clear(title);
    await user.type(title, "A better title");
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Work" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "New member — Work" }),
      " (1974){Enter}",
    );
    expect(title).toHaveValue("A better title");

    await user.click(screen.getByRole("button", { name: "Save new member" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: "A better title" }),
    );
  });

  it("does not offer quotation when choosing a new member kind", async () => {
    const user = userEvent.setup();
    render(draftElement());

    await user.click(
      screen.getByRole("button", { name: "New member — Kind" }),
    );
    expect(screen.queryByRole("option", { name: "QUOTE" })).toBeNull();
    expect(screen.getByRole("option", { name: "NOTE" })).toBeVisible();
  });

  it("renders and submits canonical keys for simultaneous system and shadow properties", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const definition: BaseDetailResponse = {
      slug: "notes",
      revision: "base-rev",
      name: "Notes",
      diagnostics: [],
      member_creation: [],
      properties: [
        { key: "kind", definition: { type: "text" } },
        { key: "word_count", definition: { type: "number" } },
        { key: "journal_date", definition: { type: "date" } },
      ],
      views: [
        {
          name: "All",
          columns: [
            "kind",
            "prop.kind",
            "prop.word_count",
            "prop.journal_date",
          ],
        },
      ],
    };
    const capability: BaseMemberCapability = {
      view: "All",
      enabled: true,
      blockers: [],
      fields: [
        { field: "kind", membership: true, view: false, embed: false },
        { field: "prop.kind", membership: false, view: true, embed: false },
        {
          field: "prop.word_count",
          membership: false,
          view: true,
          embed: false,
        },
        {
          field: "prop.journal_date",
          membership: false,
          view: true,
          embed: false,
        },
      ],
    };
    render(
      draftElement({
        fields: composeMemberDraftFields(definition, "All", capability),
        diagnostics: [
          {
            scope: "view",
            field: "prop.kind",
            filter_path: "views.PropKind.filter",
            message: "candidate does not match the selected view filter",
          },
        ],
        onSave,
      }),
    );
    const customKind = screen.getByRole("button", {
      name: "Edit New member — Kind",
    });
    expect(customKind).toHaveFocus();
    expect(customKind).toHaveAccessibleDescription(
      "Required for the active view. candidate does not match the selected view filter",
    );

    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "Namespaced",
    );
    await user.click(screen.getByRole("button", { name: "New member — Kind" }));
    await user.click(screen.getByRole("option", { name: "BOOK" }));
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Kind" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "New member — Kind" }),
      "essay{Enter}",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Word Count" }),
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "New member — Word Count" }),
      "42{Enter}",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Journal Date" }),
    );
    await user.type(
      screen.getByLabelText("New member — Journal Date"),
      "2026-08-09{Enter}",
    );
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    expect(onSave).toHaveBeenCalledWith({
      title: "Namespaced",
      fields: {
        kind: "BOOK",
        "prop.kind": "essay",
        "prop.word_count": 42,
        "prop.journal_date": "2026-08-09",
      },
    });
  });

  it("reports every user-originated draft edit without exposing draft state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(draftElement({ onChange }));

    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "D",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "New member — Rating" }),
      "9{Enter}",
    );

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1);
    expect(onChange).toHaveBeenNthCalledWith(2);
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
    ).toHaveAccessibleDescription("Required for the embedded filter.");
    expect(
      screen.getByRole("button", { name: "Edit New member — Status" }),
    ).toHaveAccessibleDescription(
      "Required for the active view and the embedded filter.",
    );
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
      "Required for the active view and the embedded filter. status must equal unread",
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
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Cancel new member" }),
    ).toBeDisabled();
  });

  it("disables only submission when no authoritative session is available", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      draftElement({
        isSaving: false,
        isSaveDisabled: true,
        onSave,
        onCancel,
      }),
    );

    const title = screen.getByRole("textbox", {
      name: "New member — Title",
    });
    const saveButton = screen.getByRole("button", {
      name: "Save new member",
    });
    expect(title).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Cancel new member" }),
    ).toBeEnabled();
    expect(saveButton).toBeDisabled();

    await user.type(title, "Authored while blocked");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Escape}");
    await user.click(saveButton);

    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(title).toHaveValue("Authored while blocked");
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

  it.each([
    ["Tags", "", "{Meta>}{Enter}{/Meta}", []],
    ["Tags", "pending-tag", "{Meta>}{Enter}{/Meta}", ["pending-tag"]],
    ["Aliases", "", "{Control>}{Enter}{/Control}", []],
    [
      "Aliases",
      "pending-alias",
      "{Control>}{Enter}{/Control}",
      ["pending-alias"],
    ],
  ] as const)(
    "saves %s with %s pending on modified Enter",
    async (label, pending, shortcut, expected) => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      render(draftElement({ onSave }));
      await user.type(
        screen.getByRole("textbox", { name: "New member — Title" }),
        "Shortcut",
      );
      const input = screen.getByRole("textbox", {
        name: `New member — ${label}`,
      });
      if (pending) await user.type(input, pending);
      await user.keyboard(shortcut);

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: expect.objectContaining({
            [label.toLowerCase()]: expected,
          }),
        }),
      );
    },
  );

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

  it("commits an active property on blur before keyboard Save activation", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const keyboardFields: BaseMemberDraftField[] = [
      {
        key: "title",
        kind: "title",
        membership: false,
        viewOnly: false,
        embedOnly: false,
      },
      {
        key: "rating",
        kind: "property",
        definition: { type: "number" },
        membership: false,
        viewOnly: false,
        embedOnly: false,
      },
    ];
    render(draftElement({ fields: keyboardFields, onSave }));
    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "Keyboard Draft",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit New member — Rating" }),
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "New member — Rating" }),
      "8",
    );

    await user.tab();
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith({
      title: "Keyboard Draft",
      fields: { rating: 8 },
    });
  });

  it("uses safe ID references for spaced property keys", async () => {
    const user = userEvent.setup();
    const spacedFields: BaseMemberDraftField[] = [
      {
        key: "title",
        kind: "title",
        membership: false,
        viewOnly: false,
        embedOnly: false,
      },
      {
        key: "reading status",
        kind: "property",
        definition: { type: "select", options: ["unread", "read"] },
        membership: false,
        viewOnly: true,
        embedOnly: false,
      },
    ];
    render(
      draftElement({
        fields: spacedFields,
        diagnostics: [
          {
            scope: "field",
            field: "reading status",
            message: "Choose a reading status.",
          },
        ],
      }),
    );

    const display = screen.getByRole("button", {
      name: "Edit New member — Reading Status",
    });
    expect(display).toHaveAccessibleDescription(
      "Required for the active view. Choose a reading status.",
    );
    expect(display.getAttribute("aria-describedby")).not.toContain(
      "reading status",
    );
    await user.click(display);
    expect(
      screen.getByRole("button", {
        name: /—.*New member — Reading Status/,
      }),
    ).toHaveAccessibleDescription(
      "Required for the active view. Choose a reading status.",
    );
  });

  it("keeps Project controlled after assign and clear", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const projectFields: BaseMemberDraftField[] = [
      {
        key: "title",
        kind: "title",
        membership: false,
        viewOnly: false,
        embedOnly: false,
      },
      {
        key: "project",
        kind: "project",
        membership: false,
        viewOnly: false,
        embedOnly: false,
      },
    ];
    render(draftElement({ fields: projectFields, onSave }));
    await user.type(
      screen.getByRole("textbox", { name: "New member — Title" }),
      "No Project",
    );
    const project = screen.getByRole("combobox", {
      name: "New member — Project",
    });
    await user.type(project, "clepsydra{Enter}");
    await user.click(
      screen.getByRole("button", { name: "Clear New member — Project" }),
    );
    expect(project).toHaveValue("");
    await user.click(project);
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Save new member" }));

    expect(onSave).toHaveBeenCalledWith({
      title: "No Project",
      fields: { project: null },
    });
  });
});
