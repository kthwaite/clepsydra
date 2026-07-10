import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChecklistBar, CycleMetric } from "../board-presentation";

describe("CycleMetric", () => {
  it("renders numeric values zero-padded with an optional color", () => {
    render(
      <CycleMetric
        label="SEALED"
        value={3}
        testId="sealed"
        color="var(--cool)"
      />,
    );

    expect(screen.getByText("SEALED")).toBeVisible();
    expect(screen.getByTestId("sealed")).toHaveTextContent("03");
    expect(screen.getByTestId("sealed")).toHaveStyle({ color: "var(--cool)" });
  });

  it("renders caller-formatted text without forcing a color", () => {
    render(<CycleMetric label="RATE" value="75%" testId="rate" />);

    expect(screen.getByTestId("rate")).toHaveTextContent("75%");
    expect(screen.getByTestId("rate")).not.toHaveAttribute("style");
  });
});

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
      background: "var(--ink-2)",
    });
  });

  it("uses the completion color and permits an unlabelled indicator", () => {
    const { container } = render(
      <ChecklistBar percent={100} isComplete className="h-[4px]" />,
    );

    expect(container.querySelector("i")).toHaveStyle({
      width: "100%",
      background: "var(--cool)",
    });
  });
});
