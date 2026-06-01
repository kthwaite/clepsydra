import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindSelect } from "#/components/codex/KindSelect";

describe("KindSelect", () => {
  it("renders the current kind label", () => {
    render(<KindSelect value="QUOTE" inferred={false} onAssign={() => {}} />);
    // The Select trigger carries aria-label="Kind"; its visible label renders
    // as the button's text content. Scope to that trigger so the assertion
    // targets only the visible control, not react-aria's hidden autofill
    // <option> (which also reads "QUOTE").
    expect(screen.getByRole("button", { name: "Kind" })).toHaveTextContent(
      "QUOTE",
    );
  });
});
