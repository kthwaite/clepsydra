import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PropertyDefinition } from "#/api/bases";
import type { CellValue } from "#/components/bases/cells/types";
import { EditableCell } from "#/components/bases/EditableCell";
import { KindSelect } from "#/components/codex/KindSelect";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { TagInput } from "#/components/ui/tag-input";

type EditableProps = Parameters<typeof EditableCell>[0];
type AccessibilityProps = Pick<EditableProps, "ariaLabel" | "ariaDescribedBy">;

interface CellHarnessProps {
  value: EditableProps["value"];
  definition: PropertyDefinition;
  accessibility?: AccessibilityProps;
  onCommit: EditableProps["onCommit"];
  onCommitNext: NonNullable<EditableProps["onCommitNext"]>;
}

function CellHarness({
  value,
  definition,
  accessibility,
  onCommit,
  onCommitNext,
}: CellHarnessProps) {
  const [isEditing, setIsEditing] = useState(false);
  return (
    <EditableCell
      value={value}
      definition={definition}
      isEditing={isEditing}
      onEdit={() => setIsEditing(true)}
      onCancel={() => setIsEditing(false)}
      onCommit={(next, hint) => {
        setIsEditing(false);
        onCommit(next, hint);
      }}
      onCommitNext={(next, hint) => {
        onCommitNext(next, hint);
        setIsEditing(false);
      }}
      {...accessibility}
    />
  );
}

function renderCell(
  value: EditableProps["value"],
  definition: PropertyDefinition,
  accessibility: AccessibilityProps = {},
) {
  const onCommit = vi.fn();
  const onCommitNext = vi.fn();
  render(
    <CellHarness
      value={value}
      definition={definition}
      accessibility={accessibility}
      onCommit={onCommit}
      onCommitNext={onCommitNext}
    />,
  );
  return { onCommit, onCommitNext };
}

describe("cell editors", () => {
  it("number cell uses a native number input and commits a numeric value", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(9, { type: "number" });
    await user.click(screen.getByRole("button", { name: "9" }));
    const input = screen.getByRole("spinbutton", { name: "Edit number" });

    await user.clear(input);
    await user.type(input, "42{Enter}");
    expect(onCommit).toHaveBeenCalledWith(42, undefined);
  });

  it("does not coerce an invalid draft number on blur", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <EditableCell
        value={9}
        definition={{ type: "number" }}
        commitOnBlur
        onCommit={onCommit}
      />,
    );
    await user.click(screen.getByRole("button", { name: "9" }));
    const input = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Edit number",
    });
    input.setCustomValidity("Enter a valid number");
    await user.tab();

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "9" })).toBeInTheDocument();
  });

  it("select cell offers the declared options", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell("queued", {
      type: "select",
      options: ["queued", "reading", "finished"],
    });
    await user.click(screen.getByRole("button", { name: "queued" }));
    const trigger = screen.getByRole("button", { name: /Edit select/ });
    await user.click(trigger);
    expect(screen.getByRole("option", { name: "reading" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "finished" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "reading" }));
    expect(onCommit).toHaveBeenCalledWith("reading", undefined);
  });

  it("select cell keeps a novel value and its null sentinel selectable", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell("archived", {
      type: "select",
      options: ["queued", "reading"],
    });
    await user.click(screen.getByRole("button", { name: "archived" }));
    const trigger = screen.getByRole("button", { name: /Edit select/ });
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByRole("option", { name: "archived" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("option", { name: "—" }));

    expect(onCommit).toHaveBeenCalledWith(null, undefined);
  });

  it("date cell commits the ISO value with a types hint", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell("2026-07-30", { type: "date" });
    await user.click(screen.getByRole("button", { name: "2026-07-30" }));
    const input = screen.getByLabelText("Edit date");
    await user.clear(input);
    await user.type(input, "2026-08-06");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("2026-08-06", "date");
  });

  it("escape reverts to the display state without committing", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell("Gene Wolfe", { type: "text" });
    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const input = screen.getByRole("textbox", { name: "Edit text" });
    await user.clear(input);
    await user.type(input, "scratch that");
    await user.keyboard("{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    // Back to display mode with the original value.
    expect(screen.getByRole("button", { name: "Gene Wolfe" })).toBeTruthy();
  });

  it("multi-select preserves the existing array when toggling a value", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory", "identity"], {
      type: "multi_select",
      options: ["memory", "identity", "style", "grief"],
    });
    await user.click(screen.getByRole("button", { name: "memory, identity" }));
    const trigger = screen.getByRole("button", {
      name: /Edit multi-select/,
    });
    await user.click(trigger);
    const style = await screen.findByRole("option", { name: "style" });
    // Toggle a third option on; the original two must survive the commit.
    await user.click(style);
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committed] = onCommit.mock.calls[0];
    expect(committed).toEqual(
      expect.arrayContaining(["memory", "identity", "style"]),
    );
    expect(committed).toHaveLength(3);
  });

  it("multi-select commits the complete latest selection on blur when enabled", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <>
        <EditableCell
          value={["memory", "identity"]}
          definition={{
            type: "multi_select",
            options: ["memory", "identity", "style"],
          }}
          commitOnBlur
          onCommit={onCommit}
        />
        <button type="button" data-testid="outside-focus">
          Outside
        </button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "memory, identity" }));
    const trigger = screen.getByRole("button", {
      name: /Edit multi-select/,
    });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "style" }));

    screen.getByTestId("outside-focus").focus();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      ["memory", "identity", "style"],
      undefined,
    );
  });

  it("multi-select cancels a changed selection with Escape", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory", "identity"], {
      type: "multi_select",
      options: ["memory", "identity", "style"],
    });
    await user.click(screen.getByRole("button", { name: "memory, identity" }));
    const trigger = screen.getByRole("button", {
      name: /Edit multi-select/,
    });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "style" }));

    await user.keyboard("{Escape}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "memory, identity" }),
    ).toBeInTheDocument();
  });

  it("datetime edit preserves the time component and zone suffix", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell("2026-08-06T14:30:00Z", {
      type: "datetime",
    });
    await user.click(
      screen.getByRole("button", { name: "2026-08-06T14:30:00Z" }),
    );
    const input = screen.getByLabelText("Edit datetime");
    // Commit without touching the value: nothing may be truncated.
    input.focus();
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("2026-08-06T14:30:00Z", "datetime");
  });

  it("relation cell edits the full multi-target list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
    );
    const user = userEvent.setup();
    const { onCommit } = renderCell(["[[Solar Cycle]]", "[[Book of Days]]"], {
      type: "relation",
    });
    await user.click(
      screen.getByRole("button", { name: "[[Solar Cycle]], [[Book of Days]]" }),
    );
    const input = screen.getByRole("textbox", { name: "Edit relation" });
    // Both existing targets are editable, not just the first.
    expect((input as HTMLInputElement).value).toBe("Solar Cycle, Book of Days");
    await user.type(input, ", Lunar Cycle{Enter}");
    expect(onCommit).toHaveBeenCalledWith(
      ["[[Solar Cycle]]", "[[Book of Days]]", "[[Lunar Cycle]]"],
      undefined,
    );
    vi.unstubAllGlobals();
  });

  it("relation cell commits wikilink syntax", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ title: "Solar Cycle", path: "s.md" }]),
      }),
    );
    const user = userEvent.setup();
    const { onCommit } = renderCell(["[[Solar Cycle]]"], { type: "relation" });
    await user.click(screen.getByRole("button", { name: "[[Solar Cycle]]" }));
    const input = screen.getByRole("combobox", { name: "Edit relation" });
    await user.clear(input);
    await user.type(input, "Lunar Cycle{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["[[Lunar Cycle]]"], undefined);
    vi.unstubAllGlobals();
  });

  it("bool cell commits its current value with Tab through onCommitNext", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitNext } = renderCell(true, { type: "bool" });
    await user.click(screen.getByRole("button", { name: "true" }));
    const trigger = screen.getByRole("button", { name: /Edit boolean/ });

    fireEvent.keyDown(trigger, { key: "Tab" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitNext).toHaveBeenCalledWith(true, undefined);
  });

  it("select cell commits its current value with Tab through onCommitNext", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitNext } = renderCell("queued", {
      type: "select",
      options: ["queued", "reading"],
    });
    await user.click(screen.getByRole("button", { name: "queued" }));
    const trigger = screen.getByRole("button", { name: /Edit select/ });

    fireEvent.keyDown(trigger, { key: "Tab" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitNext).toHaveBeenCalledWith("queued", undefined);
  });

  it("select cell cancels from an open popover with Escape", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell("queued", {
      type: "select",
      options: ["queued", "reading"],
    });
    await user.click(screen.getByRole("button", { name: "queued" }));
    const trigger = screen.getByRole("button", { name: /Edit select/ });
    await user.click(trigger);
    const option = await screen.findByRole("option", { name: "reading" });

    fireEvent.keyDown(option, { key: "Escape" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "queued" })).toBeInTheDocument();
  });

  it("date cell commits its draft and type hint with Tab through onCommitNext", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitNext } = renderCell("2026-07-30", {
      type: "date",
    });
    await user.click(screen.getByRole("button", { name: "2026-07-30" }));
    const input = screen.getByLabelText("Edit date");
    fireEvent.change(input, { target: { value: "2026-08-06" } });

    fireEvent.keyDown(input, { key: "Tab" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitNext).toHaveBeenCalledWith("2026-08-06", "date");
  });

  it("datetime cell preserves its zone suffix when committing with Tab", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitNext } = renderCell("2026-08-06T14:30:00Z", {
      type: "datetime",
    });
    await user.click(
      screen.getByRole("button", { name: "2026-08-06T14:30:00Z" }),
    );
    const input = screen.getByLabelText("Edit datetime");

    fireEvent.keyDown(input, { key: "Tab" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitNext).toHaveBeenCalledWith(
      "2026-08-06T14:30:00Z",
      "datetime",
    );
  });

  it("multi-select cell commits its complete selection with Tab", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitNext } = renderCell(["memory", "identity"], {
      type: "multi_select",
      options: ["memory", "identity", "style"],
    });
    await user.click(screen.getByRole("button", { name: "memory, identity" }));
    const trigger = screen.getByRole("button", {
      name: /Edit multi-select/,
    });
    await user.click(trigger);
    const style = await screen.findByRole("option", { name: "style" });
    await user.click(style);

    fireEvent.keyDown(style, { key: "Tab" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitNext).toHaveBeenCalledWith(
      ["memory", "identity", "style"],
      undefined,
    );
  });

  it("relation cell serializes every target when committing with Tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
    );
    const user = userEvent.setup();
    const { onCommit, onCommitNext } = renderCell(["[[Solar Cycle]]"], {
      type: "relation",
    });
    await user.click(screen.getByRole("button", { name: "[[Solar Cycle]]" }));
    const input = screen.getByRole("combobox", { name: "Edit relation" });
    fireEvent.change(input, { target: { value: "Lunar Cycle, Book of Days" } });

    fireEvent.keyDown(input, { key: "Tab" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitNext).toHaveBeenCalledWith(
      ["[[Lunar Cycle]]", "[[Book of Days]]"],
      undefined,
    );
    vi.unstubAllGlobals();
  });
  const accessibleEditorCases: Array<
    [name: string, value: CellValue, definition: PropertyDefinition]
  > = [
    ["text", "", { type: "text" }],
    ["url", "", { type: "url" }],
    ["number", null, { type: "number" }],
    ["boolean", null, { type: "bool" }],
    ["date", "", { type: "date" }],
    ["datetime", "", { type: "datetime" }],
    ["select", null, { type: "select", options: ["one"] }],
    ["multi-select", [], { type: "multi_select", options: ["one"] }],
    ["relation", [], { type: "relation" }],
  ];

  it.each(accessibleEditorCases)(
    "propagates an accessible override to the %s editor",
    async (_name, value, definition) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
      );
      const user = userEvent.setup();
      render(
        <>
          <p id="custom-description">A helpful description</p>
          <EditableCell
            value={value}
            definition={definition}
            ariaLabel="Custom field"
            ariaDescribedBy="custom-description"
            onCommit={vi.fn()}
          />
        </>,
      );

      const display = screen.getByRole("button", {
        name: "Edit Custom field",
      });
      expect(display).toHaveAccessibleDescription("A helpful description");
      await user.click(display);
      const editor = screen.getByLabelText("Custom field");
      expect(editor).toHaveAccessibleDescription("A helpful description");
      vi.unstubAllGlobals();
    },
  );
});

describe("metadata control accessibility", () => {
  it("preserves default labels", () => {
    render(
      <>
        <KindSelect value="NOTE" inferred={false} onAssign={vi.fn()} />
        <ProjectCombo
          value={null}
          options={["clepsydra"]}
          onAssign={vi.fn()}
          onClear={vi.fn()}
        />
        <TagInput label="Tags" values={[]} onChange={vi.fn()} />
      </>,
    );

    expect(screen.getByRole("combobox", { name: "Kind" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Add tags" }),
    ).toBeInTheDocument();
  });

  it("propagates custom labels and descriptions", () => {
    render(
      <>
        <p id="kind-description">Kind help</p>
        <p id="project-description">Project help</p>
        <p id="tags-description">Tags help</p>
        <KindSelect
          value="NOTE"
          inferred={false}
          ariaLabel="Draft kind"
          ariaDescribedBy="kind-description"
          onAssign={vi.fn()}
        />
        <ProjectCombo
          value={null}
          options={["clepsydra"]}
          ariaLabel="Draft project"
          ariaDescribedBy="project-description"
          onAssign={vi.fn()}
          onClear={vi.fn()}
        />
        <TagInput
          label="Tags"
          values={[]}
          ariaLabel="Draft tags"
          ariaDescribedBy="tags-description"
          onChange={vi.fn()}
        />
      </>,
    );

    expect(
      screen.getByRole("combobox", { name: "Draft kind" }),
    ).toHaveAccessibleDescription("Kind help");
    expect(
      screen.getByRole("combobox", { name: "Draft project" }),
    ).toHaveAccessibleDescription("Project help");
    expect(
      screen.getByRole("textbox", { name: "Draft tags" }),
    ).toHaveAccessibleDescription("Tags help");
  });
});
