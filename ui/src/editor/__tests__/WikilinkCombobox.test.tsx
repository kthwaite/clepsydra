import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
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
    computed_tags: [],
  },
];
function renderCombobox(
  overrides: Partial<React.ComponentProps<typeof WikilinkCombobox>> = {},
) {
  return render(
    <WikilinkCombobox
      pages={[]}
      query="New Topic"
      reference={makeVirtualReference(120, 80)}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe("WikilinkCombobox", () => {
  it("does not render or create when no reference is available", () => {
    const onCreate = vi.fn();
    renderCombobox({ reference: null, onCreate });

    expect(screen.queryByText("Create “New Topic”")).toBeNull();
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("offers creation only for a non-empty zero-match query", () => {
    renderCombobox();
    expect(screen.getByText("Create “New Topic”")).toBeInTheDocument();
  });

  it("does not offer creation when a partial match exists", () => {
    renderCombobox({ pages, query: "design" });
    expect(screen.getByText("Design Notes")).toBeInTheDocument();
    expect(screen.queryByText(/Create/)).toBeNull();
  });

  it("dispatches page suggestions to onSelect only", async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderCombobox({ pages, query: "design", onSelect, onCreate });
    await user.click(screen.getByText("Design Notes"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(pages[0]);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not offer creation for whitespace", () => {
    renderCombobox({ pages: [], query: "   " });
    expect(screen.queryByText(/Create/)).toBeNull();
  });

  it("activates creation by mouse", async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderCombobox({ onCreate });
    await user.click(screen.getByText("Create “New Topic”"));
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledWith("New Topic");
  });

  it.each(["Enter", "Tab"])("activates creation with %s", (key: string) => {
    const onCreate = vi.fn();
    renderCombobox({ onCreate });
    fireEvent.keyDown(document, { key });
    expect(onCreate).toHaveBeenCalledWith("New Topic");
  });

  it("renders pending copy and prevents duplicate creation", () => {
    const onCreate = vi.fn();
    renderCombobox({ isCreating: true, onCreate });
    expect(screen.getByText("Creating…")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("renders error copy and allows retry", () => {
    const onCreate = vi.fn();
    renderCombobox({ createError: "request failed", onCreate });
    expect(
      screen.getByText("Creation failed — press Enter to retry"),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith("New Topic");
  });

  it("renders after a valid virtual selection reference is provided", async () => {
    const { rerender } = renderCombobox({
      pages,
      query: "des",
      reference: null,
    });

    expect(screen.queryByText("Design Notes")).toBeNull();

    rerender(
      <WikilinkCombobox
        pages={pages}
        query="des"
        reference={makeVirtualReference(120, 80)}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
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
