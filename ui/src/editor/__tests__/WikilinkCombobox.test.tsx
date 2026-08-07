import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageSummary } from "#/api/types";
import { WikilinkCombobox } from "../WikilinkCombobox";

function makeVirtualReference(left: number, top: number, height = 18) {
  return {
    getBoundingClientRect: () => ({
      x: left,
      y: top,
      left,
      top,
      right: left,
      bottom: top + height,
      width: 0,
      height,
      toJSON: () => ({}),
    }),
  };
}

const pages: PageSummary[] = [
  {
    id: "p1",
    title: "Design Notes",
    canonical_name: "design-notes",
    path: "notes/design-notes.md",
    kind: "NOTE",
    inferred: true,
    encrypted: false,
    tags: [],
  },
];

describe("WikilinkCombobox", () => {
  it("does not render when no reference is available", () => {
    render(
      <WikilinkCombobox
        pages={pages}
        query="des"
        reference={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("Design Notes")).toBeNull();
  });

  it("renders after a valid virtual selection reference is provided", async () => {
    const { rerender } = render(
      <WikilinkCombobox
        pages={pages}
        query="des"
        reference={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("Design Notes")).toBeNull();

    rerender(
      <WikilinkCombobox
        pages={pages}
        query="des"
        reference={makeVirtualReference(120, 80)}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const option = await screen.findByText("Design Notes");
    const popup = option.closest("div.fixed");

    expect(popup).not.toBeNull();

    await waitFor(() => {
      const { transform } = (popup as HTMLDivElement).style;
      const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);

      expect(match).not.toBeNull();
      const x = Number.parseFloat(match?.[1] ?? "NaN");
      const y = Number.parseFloat(match?.[2] ?? "NaN");

      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThan(0);
      expect(y).toBeGreaterThan(0);
    });
  });
});
