import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindSelect } from "#/components/codex/KindSelect";

describe("KindSelect", () => {
  it("renders the current kind label", () => {
    render(<KindSelect value="QUOTE" inferred={false} onAssign={() => {}} />);
    expect(screen.getByText("QUOTE")).toBeInTheDocument();
  });
});
