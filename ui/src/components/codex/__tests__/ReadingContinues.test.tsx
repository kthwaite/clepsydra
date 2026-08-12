import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ReadingContinues,
  ReadingContinuesPanel,
} from "#/components/codex/ReadingContinues";

const commit = vi.fn().mockResolvedValue(undefined);

vi.mock("#/api/bases", () => ({
  useBaseView: () => ({
    data: {
      shape: "flat",
      total: 2,
      rows: [
        {
          id: "01",
          path: "book-of-the-new-sun.md",
          title: "The Book of the New Sun",
          kind: "BOOK",
          columns: { author: "Gene Wolfe", progress: 120, pages: 371 },
        },
        {
          id: "02",
          path: "invisible-cities.md",
          title: "Invisible Cities",
          kind: "BOOK",
          columns: { author: "Italo Calvino", progress: 40, pages: 165 },
        },
      ],
    },
  }),
  usePropertyCommit: () => commit,
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => vi.fn(),
}));

describe("ReadingContinuesPanel", () => {
  it("renders rows from the continues view response", () => {
    render(<ReadingContinuesPanel />);
    expect(screen.getByText("The Book of the New Sun")).toBeTruthy();
    expect(screen.getByText("Invisible Cities")).toBeTruthy();
    expect(screen.getByText("Gene Wolfe")).toBeTruthy();
    expect(screen.getByText("120/371")).toBeTruthy();
    expect(screen.getByText("2 in flight")).toBeTruthy();
  });

  it("progress affordance issues a progress property patch", async () => {
    const user = userEvent.setup();
    render(<ReadingContinuesPanel />);
    await user.click(
      screen.getByRole("button", {
        name: "Advance The Book of the New Sun by 10 pages",
      }),
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "01", path: "book-of-the-new-sun.md" }),
      "progress",
      130,
    );
  });
});

describe("ReadingContinues", () => {
  it("renders nothing without rows and clamps advance to the page count", async () => {
    const user = userEvent.setup();
    const onAdvance = vi.fn();
    const { container, rerender } = render(
      <ReadingContinues rows={[]} onOpen={vi.fn()} onAdvance={onAdvance} />,
    );
    expect(container.innerHTML).toBe("");

    rerender(
      <ReadingContinues
        rows={[
          {
            id: "03",
            path: "almost-done.md",
            title: "Almost Done",
            progress: 195,
            pages: 200,
          },
        ]}
        onOpen={vi.fn()}
        onAdvance={onAdvance}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Advance Almost Done by 10 pages" }),
    );
    expect(onAdvance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "03" }),
      200,
    );
  });
});
