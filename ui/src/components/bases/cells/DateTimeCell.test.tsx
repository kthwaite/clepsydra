import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PropertyDefinition } from "#/api/bases";
import { DateTimeCell } from "./DateTimeCell";

const DEFINITION: PropertyDefinition = { type: "datetime" };

function renderCell(value: string | null) {
  const onCommit = vi.fn();
  render(
    <DateTimeCell
      value={value}
      definition={DEFINITION}
      onCommit={onCommit}
      onCommitNext={vi.fn()}
      onCancel={vi.fn()}
      ariaLabel="occurred at"
      commitOnBlur
    />,
  );
  return { input: screen.getByLabelText("occurred at"), onCommit };
}

describe("DateTimeCell", () => {
  it("gives a seconds-less value its seconds", () => {
    // Browsers drop `:00` even at step={1}, and `2026-08-28T09:30` is not a
    // TOML date-time — unpadded it would be stored as an inert string.
    const { input, onCommit } = renderCell(null);

    fireEvent.change(input, { target: { value: "2026-08-28T09:30" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("2026-08-28T09:30:00", "datetime");
  });

  it("keeps seconds the author typed, and the original zone suffix", () => {
    const { input, onCommit } = renderCell("2026-08-27T14:00:00Z");

    fireEvent.change(input, { target: { value: "2026-08-28T09:30:45" } });
    fireEvent.blur(input);

    // The input may normalize its own precision (jsdom appends `.000`); what
    // matters is that the seconds survive and the suffix comes back.
    const [value, hint] = onCommit.mock.calls[0];
    expect(value).toMatch(/^2026-08-28T09:30:45(\.\d+)?Z$/);
    expect(hint).toBe("datetime");
  });

  it("clears the value rather than padding an empty draft", () => {
    const { input, onCommit } = renderCell("2026-08-27T14:00:00Z");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(null);
  });
});
