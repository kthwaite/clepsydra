import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkMissView } from "#/routes/link-miss";

describe("LinkMissView", () => {
  it("shows the unresolved target", () => {
    render(<LinkMissView target="clepsydra://page/nope" />);
    expect(screen.getByText("clepsydra://page/nope")).toBeInTheDocument();
    expect(screen.getByText(/no page matches/i)).toBeInTheDocument();
  });

  it("renders without a target", () => {
    render(<LinkMissView />);
    expect(screen.getByText(/no page matches/i)).toBeInTheDocument();
  });
});
