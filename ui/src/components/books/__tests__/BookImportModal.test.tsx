import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { importMutate, openTabMock, mutationState } = vi.hoisted(() => ({
  importMutate: vi.fn(),
  openTabMock: vi.fn(),
  mutationState: { isPending: false },
}));

vi.mock("#/api/academic", () => ({
  useImportIsbn: () => ({
    mutate: importMutate,
    isPending: mutationState.isPending,
  }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { BookImportModal } from "#/components/books/BookImportModal";
import { useUiStore } from "#/store/ui";

describe("BookImportModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationState.isPending = false;
    useUiStore.setState({ isBookImportOpen: true });
  });

  it("focuses manual ISBN entry", () => {
    render(<BookImportModal />);
    expect(screen.getByRole("textbox", { name: "ISBN" })).toHaveFocus();
  });

  it("keeps invalid input local", async () => {
    const user = userEvent.setup();
    render(<BookImportModal />);

    await user.type(screen.getByRole("textbox", { name: "ISBN" }), "1234");
    await user.click(screen.getByRole("button", { name: "Add book" }));

    expect(importMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid ISBN-10 or ISBN-13",
    );
  });

  it("submits canonical ISBN-13", async () => {
    const user = userEvent.setup();
    render(<BookImportModal />);

    await user.type(
      screen.getByRole("textbox", { name: "ISBN" }),
      "0-262-01153-0",
    );
    await user.click(screen.getByRole("button", { name: "Add book" }));

    expect(importMutate).toHaveBeenCalledWith(
      { body: { isbn: "9780262011532" } },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it.each([
    "created",
    "skipped",
  ])("opens the returned page after a %s response", async (status) => {
    const user = userEvent.setup();
    importMutate.mockImplementation((_request, options) =>
      options?.onSuccess?.({
        cite_key: "abelson1996structure",
        status,
        page_path: "library/books/structure.md",
      }),
    );
    render(<BookImportModal />);

    await user.type(
      screen.getByRole("textbox", { name: "ISBN" }),
      "9780262011532",
    );
    await user.click(screen.getByRole("button", { name: "Add book" }));

    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "library/books/structure.md",
      "Imported book",
    );
    expect(useUiStore.getState().isBookImportOpen).toBe(false);
  });

  it("keeps the ISBN after an API error", async () => {
    const user = userEvent.setup();
    importMutate.mockImplementation((_request, options) =>
      options?.onError?.({ error: "Open Library returned 404 Not Found" }),
    );
    render(<BookImportModal />);

    const input = screen.getByRole("textbox", { name: "ISBN" });
    await user.type(input, "9780262011532");
    await user.click(screen.getByRole("button", { name: "Add book" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Open Library returned 404 Not Found",
    );
    expect(input).toHaveValue("9780262011532");
    expect(useUiStore.getState().isBookImportOpen).toBe(true);
  });

  it("disables submission while pending", () => {
    mutationState.isPending = true;
    render(<BookImportModal />);
    expect(screen.getByRole("button", { name: "Adding book…" })).toBeDisabled();
  });

  it("dismisses on Escape and resets before reopening", async () => {
    const user = userEvent.setup();
    const view = render(<BookImportModal />);
    await user.type(screen.getByRole("textbox", { name: "ISBN" }), "discard");
    await user.keyboard("{Escape}");
    expect(useUiStore.getState().isBookImportOpen).toBe(false);

    useUiStore.getState().openBookImport();
    view.rerender(<BookImportModal />);
    expect(screen.getByRole("textbox", { name: "ISBN" })).toHaveValue("");
  });
});
