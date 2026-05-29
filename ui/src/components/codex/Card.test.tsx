import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  it("renders label, caption, and children", () => {
    render(
      <Card label="Inventory" caption="FIG. I — TELEMETRY">
        <p>body</p>
      </Card>,
    );
    expect(screen.getByText("Inventory")).toBeInTheDocument();
    expect(screen.getByText("FIG. I — TELEMETRY")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("omits the caption node when none is given", () => {
    render(<Card label="Sky">x</Card>);
    expect(screen.queryByText(/FIG\./)).not.toBeInTheDocument();
  });
});
