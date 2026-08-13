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
    aliases: [],
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

  it("offers creation for a non-empty zero-match query", () => {
    renderCombobox();
    expect(screen.getByText("Create “New Topic”")).toBeInTheDocument();
  });

  it("renders partial matches before a trailing Create row", () => {
    renderCombobox({ pages, query: "design" });

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Design Notesnotes/design-notes.md",
      "Create “design”",
    ]);
  });

  it.each([
    ["title", "Design Notes", {}],
    ["canonical name", "design-notes", {}],
    ["alias", "design", { aliases: ["design"] }],
    ["path without suffix", "notes/design-notes", {}],
    ["path with suffix", "notes/design-notes.md", {}],
  ])(
    "suppresses Create for an exact %s identity",
    (_field, query, pageOverrides) => {
      renderCombobox({
        pages: [{ ...pages[0], ...pageOverrides }],
        query,
      });

      expect(screen.getByText("Design Notes")).toBeInTheDocument();
      expect(screen.queryByText(/Create/)).toBeNull();
    },
  );

  it("suppresses Create for an exact alias omitted by substring filtering", () => {
    renderCombobox({
      pages: [{ ...pages[0], aliases: ["Blueprint"] }],
      query: "blueprint",
    });

    expect(screen.queryByText("Design Notes")).toBeNull();
    expect(screen.queryByText(/Create/)).toBeNull();
  });

  it.each([
    ["NFC", "Cafe\u0301 Notes", { title: "Café Notes" }],
    ["collapsed whitespace", "Design   Notes", {}],
  ])(
    "suppresses Create when exact %s identity is omitted by raw filtering",
    (_normalization, query, pageOverrides) => {
      renderCombobox({
        pages: [{ ...pages[0], ...pageOverrides }],
        query,
      });

      expect(screen.queryByText(/Create/)).toBeNull();
    },
  );

  it("reaches the trailing Create row with the keyboard", () => {
    const onCreate = vi.fn();
    renderCombobox({ pages, query: "design", onCreate });

    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledWith("design");
  });

  it("keeps the first eight matching pages in order before Create", () => {
    const manyPages = Array.from({ length: 9 }, (_, index): PageSummary => ({
      ...pages[0],
      id: `p${index}`,
      title: `Topic ${index}`,
      canonical_name: `topic-${index}`,
      path: `notes/topic-${index}.md`,
    }));

    renderCombobox({ pages: manyPages, query: "topic" });

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Topic 0notes/topic-0.md",
      "Topic 1notes/topic-1.md",
      "Topic 2notes/topic-2.md",
      "Topic 3notes/topic-3.md",
      "Topic 4notes/topic-4.md",
      "Topic 5notes/topic-5.md",
      "Topic 6notes/topic-6.md",
      "Topic 7notes/topic-7.md",
      "Create “topic”",
    ]);
  });

  it("suppresses Create when the exact page is beyond the eight-row cap", () => {
    const manyPages = Array.from({ length: 9 }, (_, index): PageSummary => ({
      ...pages[0],
      id: `p${index}`,
      title: index === 8 ? "Topic" : `Topic ${index}`,
      canonical_name: `topic-${index}`,
      path: `notes/topic-${index}.md`,
    }));

    renderCombobox({ pages: manyPages, query: "topic" });

    expect(screen.getAllByRole("option")).toHaveLength(8);
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
