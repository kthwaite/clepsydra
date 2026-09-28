import { act, fireEvent, render, screen } from "@testing-library/react";
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
  onCommitPrevious: NonNullable<EditableProps["onCommitPrevious"]>;
  suggestions?: string[];
}

function CellHarness({
  value,
  definition,
  accessibility,
  onCommit,
  onCommitNext,
  onCommitPrevious,
  suggestions,
}: CellHarnessProps) {
  const [isEditing, setIsEditing] = useState(false);
  return (
    <EditableCell
      value={value}
      definition={definition}
      suggestions={suggestions}
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
      onCommitPrevious={(next, hint) => {
        onCommitPrevious(next, hint);
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
  suggestions?: string[],
) {
  const onCommit = vi.fn();
  const onCommitNext = vi.fn();
  const onCommitPrevious = vi.fn();
  render(
    <CellHarness
      value={value}
      definition={definition}
      accessibility={accessibility}
      onCommit={onCommit}
      onCommitNext={onCommitNext}
      onCommitPrevious={onCommitPrevious}
      suggestions={suggestions}
    />,
  );
  return { onCommit, onCommitNext, onCommitPrevious };
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
  const shiftTabCases: Array<
    [
      name: string,
      value: CellValue,
      definition: PropertyDefinition,
      display: string,
      editor: RegExp,
      expected: [CellValue, string | undefined],
    ]
  > = [
    [
      "text",
      "Gene",
      { type: "text" },
      "Gene",
      /Edit text/,
      ["Gene", undefined],
    ],
    ["number", 9, { type: "number" }, "9", /Edit number/, [9, undefined]],
    [
      "date",
      "2026-07-30",
      { type: "date" },
      "2026-07-30",
      /Edit date$/,
      ["2026-07-30", "date"],
    ],
    [
      "datetime",
      "2026-08-06T14:30:00Z",
      { type: "datetime" },
      "2026-08-06T14:30:00Z",
      /Edit datetime/,
      ["2026-08-06T14:30:00Z", "datetime"],
    ],
    [
      "relation",
      ["[[Solar Cycle]]"],
      { type: "relation" },
      "[[Solar Cycle]]",
      /Edit relation/,
      [["[[Solar Cycle]]"], undefined],
    ],
    [
      "select",
      "queued",
      { type: "select", options: ["queued", "reading"] },
      "queued",
      /Edit select/,
      ["queued", undefined],
    ],
    ["bool", true, { type: "bool" }, "true", /Edit boolean/, [true, undefined]],
    [
      "multi-select",
      ["memory"],
      { type: "multi_select", options: ["memory", "style"] },
      "memory",
      /^Edit multi-select$/,
      [["memory"], undefined],
    ],
  ];

  it.each(shiftTabCases)(
    "%s cell commits its value with Shift+Tab through onCommitPrevious",
    async (_name, value, definition, display, editor, expected) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
      );
      const user = userEvent.setup();
      const { onCommit, onCommitNext, onCommitPrevious } = renderCell(
        value,
        definition,
      );
      await user.click(screen.getByRole("button", { name: display }));
      const target = screen.getByLabelText(editor);

      expect(fireEvent.keyDown(target, { key: "Tab", shiftKey: true })).toBe(
        false,
      );

      expect(onCommit).not.toHaveBeenCalled();
      expect(onCommitNext).not.toHaveBeenCalled();
      expect(onCommitPrevious).toHaveBeenCalledWith(...expected);
      vi.unstubAllGlobals();
    },
  );

  it("number cell stays open when Shift+Tab meets an invalid value", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitPrevious } = renderCell(9, { type: "number" });
    await user.click(screen.getByRole("button", { name: "9" }));
    const input = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Edit number",
    });
    input.setCustomValidity("Enter a valid number");

    expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(
      false,
    );

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitPrevious).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
  });

  it.each(shiftTabCases)(
    "%s draft editor leaves Shift+Tab to the browser",
    async (_name, value, definition, display, editor) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
      );
      const user = userEvent.setup();
      const onCommit = vi.fn();
      render(
        <EditableCell
          value={value}
          definition={definition}
          commitOnBlur
          onCommit={onCommit}
        />,
      );
      await user.click(screen.getByRole("button", { name: display }));
      const target = screen.getByLabelText(editor);

      expect(fireEvent.keyDown(target, { key: "Tab", shiftKey: true })).toBe(
        true,
      );
      expect(onCommit).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    },
  );

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

describe("multi-select tag editor", () => {
  const hops: PropertyDefinition = { type: "multi_select" };
  const moods: PropertyDefinition = {
    type: "multi_select",
    options: ["memory", "identity", "style", "grief"],
  };

  async function openEditor(
    user: ReturnType<typeof userEvent.setup>,
    display: string,
  ) {
    await user.click(screen.getByRole("button", { name: display }));
    const input = screen.getByRole("combobox", { name: "Edit multi-select" });
    expect(input).toHaveFocus();
    return input;
  }

  it("adds a value to an open-vocabulary empty cell and commits it", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(null, hops);
    await openEditor(user, "—");

    await user.keyboard("Citra{Enter}");
    expect(
      screen.getByRole("grid", { name: "Edit multi-select values" }),
    ).toHaveTextContent("Citra");
    expect(onCommit).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["Citra"], undefined);
  });

  it("preserves existing values and appends a new one", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory", "identity"], moods);
    await openEditor(user, "memory, identity");

    await user.keyboard("Sorrow{Enter}{Enter}");

    expect(onCommit).toHaveBeenCalledWith(
      ["memory", "identity", "Sorrow"],
      undefined,
    );
  });

  it("chooses a declared option from the suggestions", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory"], moods);
    await openEditor(user, "memory");

    await user.keyboard("sty");
    expect(screen.getByRole("option", { name: "style" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}{Enter}");

    expect(onCommit).toHaveBeenCalledWith(["memory", "style"], undefined);
  });

  it("chooses a column value from the suggestions without cancelling", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(null, hops, {}, ["Mosaic", "Citra"]);
    await openEditor(user, "—");

    await user.keyboard("mos");
    await user.click(screen.getByRole("option", { name: "Mosaic" }));
    expect(
      screen.getByRole("combobox", { name: "Edit multi-select" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledWith(["Mosaic"], undefined);
  });

  it("lists each suggestion once", async () => {
    const user = userEvent.setup();
    renderCell(null, { type: "multi_select", options: ["Mosaic"] }, {}, [
      "Mosaic",
      "Mosaic",
    ]);
    await openEditor(user, "—");

    await user.keyboard("mos");

    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("does not add a duplicate value", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["Citra"], hops);
    await openEditor(user, "Citra");

    await user.keyboard("Citra{Enter}citra{Enter}{Enter}");

    expect(onCommit).toHaveBeenCalledWith(["Citra"], undefined);
  });

  it("removes the last chip with Backspace on an empty field", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory", "identity"], moods);
    await openEditor(user, "memory, identity");

    await user.keyboard("{Backspace}{Enter}");

    expect(onCommit).toHaveBeenCalledWith(["memory"], undefined);
  });

  it("commits null when the last value is removed", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory"], moods);
    await openEditor(user, "memory");

    await user.keyboard("{Backspace}{Enter}");

    expect(onCommit).toHaveBeenCalledWith(null, undefined);
  });

  it("commits the unchanged set with Enter on an empty field", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory", "identity"], moods);
    await openEditor(user, "memory, identity");

    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["memory", "identity"], undefined);
  });

  it("closes open suggestions with Escape before cancelling", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory"], moods);
    await openEditor(user, "memory");

    await user.keyboard("sty");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Edit multi-select" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "memory" })).toBeInTheDocument();
  });

  it("commits the complete set with Tab and moves forward", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitNext } = renderCell(["memory"], moods);
    await openEditor(user, "memory");

    await user.keyboard("style{Enter}{Tab}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitNext).toHaveBeenCalledTimes(1);
    expect(onCommitNext).toHaveBeenCalledWith(["memory", "style"], undefined);
  });

  it("commits the complete set with Shift+Tab and moves back", async () => {
    const user = userEvent.setup();
    const { onCommit, onCommitPrevious } = renderCell(["memory"], moods);
    await openEditor(user, "memory");

    await user.keyboard("style{Enter}{Shift>}{Tab}{/Shift}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCommitPrevious).toHaveBeenCalledTimes(1);
    expect(onCommitPrevious).toHaveBeenCalledWith(
      ["memory", "style"],
      undefined,
    );
  });

  it("includes typed-but-unadded text in a Tab commit", async () => {
    const user = userEvent.setup();
    const { onCommitNext } = renderCell(["memory"], moods);
    await openEditor(user, "memory");

    await user.keyboard("grief{Tab}");

    expect(onCommitNext).toHaveBeenCalledWith(["memory", "grief"], undefined);
  });

  it("cancels inline edits on blur", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderCell(["memory"], moods);
    await openEditor(user, "memory");

    await user.keyboard("style{Enter}");
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "memory" })).toBeInTheDocument();
  });

  it("commits the complete set on blur in a draft", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <>
        <EditableCell
          value={["memory", "identity"]}
          definition={moods}
          commitOnBlur
          onCommit={onCommit}
        />
        <button type="button" data-testid="outside-focus">
          Outside
        </button>
      </>,
    );
    await openEditor(user, "memory, identity");

    await user.keyboard("style{Enter}grief");
    act(() => {
      screen.getByTestId("outside-focus").focus();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      ["memory", "identity", "style", "grief"],
      undefined,
    );
  });

  it("keeps a draft editor open while focus moves to a chip's remove button", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <EditableCell
        value={["memory", "identity"]}
        definition={moods}
        commitOnBlur
        onCommit={onCommit}
      />,
    );
    await openEditor(user, "memory, identity");

    const removeButtons = screen.getAllByRole("button", { name: /Remove/ });
    act(() => {
      removeButtons[0].focus();
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "Edit multi-select" }),
    ).toBeInTheDocument();
  });
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
