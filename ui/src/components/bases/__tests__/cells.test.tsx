import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PropertyDefinition } from "#/api/bases";
import { EditableCell } from "#/components/bases/EditableCell";

function renderCell(
  value: Parameters<typeof EditableCell>[0]["value"],
  definition: PropertyDefinition,
) {
  const onCommit = vi.fn();
  render(
    <EditableCell value={value} definition={definition} onCommit={onCommit} />,
  );
  return onCommit;
}

describe("cell editors", () => {
  it("number cell rejects a non-numeric commit and accepts a numeric one", async () => {
    const user = userEvent.setup();
    const onCommit = renderCell(9, { type: "number" });
    await user.click(screen.getByRole("button", { name: "9" }));
    const input = screen.getByRole("textbox", { name: "Edit number" });

    await user.clear(input);
    await user.type(input, "not-a-number{Enter}");
    expect(onCommit).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "42{Enter}");
    expect(onCommit).toHaveBeenCalledWith(42, undefined);
  });

  it("select cell offers the declared options", async () => {
    const user = userEvent.setup();
    const onCommit = renderCell("queued", {
      type: "select",
      options: ["queued", "reading", "finished"],
    });
    await user.click(screen.getByRole("button", { name: "queued" }));
    const select = screen.getByRole("combobox", { name: "Edit select" });
    const labels = Array.from(select.querySelectorAll("option")).map(
      (o) => o.value,
    );
    expect(labels).toContain("reading");
    expect(labels).toContain("finished");

    await user.selectOptions(select, "reading");
    expect(onCommit).toHaveBeenCalledWith("reading", undefined);
  });

  it("date cell commits the ISO value with a types hint", async () => {
    const user = userEvent.setup();
    const onCommit = renderCell("2026-07-30", { type: "date" });
    await user.click(screen.getByRole("button", { name: "2026-07-30" }));
    const input = screen.getByLabelText("Edit date");
    await user.clear(input);
    await user.type(input, "2026-08-06");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("2026-08-06", "date");
  });

  it("escape reverts to the display state without committing", async () => {
    const user = userEvent.setup();
    const onCommit = renderCell("Gene Wolfe", { type: "text" });
    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const input = screen.getByRole("textbox", { name: "Edit text" });
    await user.clear(input);
    await user.type(input, "scratch that");
    await user.keyboard("{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    // Back to display mode with the original value.
    expect(screen.getByRole("button", { name: "Gene Wolfe" })).toBeTruthy();
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
    const onCommit = renderCell(["[[Solar Cycle]]"], { type: "relation" });
    await user.click(screen.getByRole("button", { name: "[[Solar Cycle]]" }));
    const input = screen.getByRole("combobox", { name: "Edit relation" });
    await user.clear(input);
    await user.type(input, "Lunar Cycle{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["[[Lunar Cycle]]"], undefined);
    vi.unstubAllGlobals();
  });
});
