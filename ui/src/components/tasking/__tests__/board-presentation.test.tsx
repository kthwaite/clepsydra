import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChecklistBar } from "../board-presentation";

describe("ChecklistBar", () => {
  it("renders percentage width and the incomplete color on its indicator", () => {
    render(
      <ChecklistBar
        percent={50}
        isComplete={false}
        className="h-[6px]"
        indicatorTestId="checklist-indicator"
      />,
    );

    expect(screen.getByTestId("checklist-indicator")).toHaveStyle({
      width: "50%",
      background: "var(--mute)",
    });
  });

  it("uses the completion color and permits an unlabelled indicator", () => {
    const { container } = render(
      <ChecklistBar percent={100} isComplete className="h-[4px]" />,
    );

    expect(container.querySelector("i")).toHaveStyle({
      width: "100%",
      background: "var(--accent)",
    });
  });
});
