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
vi.mock("#/components/books/BookBarcodeScanner", () => ({
  BookBarcodeScanner: ({
    onCapture,
    onCancel,
  }: {
    onCapture: (isbn: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="mock-book-scanner">
      <button onClick={() => onCapture("9780262011532")} type="button">
        Simulate barcode
      </button>
      <button onClick={onCancel} type="button">
        Cancel mock scanner
      </button>
    </div>
  ),
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

  it("allows the ISBN-10 X check digit on mobile keyboards", () => {
    render(<BookImportModal />);
    expect(screen.getByRole("textbox", { name: "ISBN" })).toHaveAttribute(
      "inputmode",
      "text",
    );
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

  it.each(["created", "skipped"])(
    "opens the returned page after a %s response",
    async (status) => {
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
    },
  );

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

  it("fills the ISBN after scanning and waits for explicit submission", async () => {
    const user = userEvent.setup();
    render(<BookImportModal />);

    await user.click(screen.getByRole("button", { name: "Scan barcode" }));
    expect(screen.getByTestId("mock-book-scanner")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simulate barcode" }));

    expect(screen.getByRole("textbox", { name: "ISBN" })).toHaveValue(
      "9780262011532",
    );
    expect(screen.queryByTestId("mock-book-scanner")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Barcode captured. Choose Add book to import it.",
    );
    expect(importMutate).not.toHaveBeenCalled();
  });

  it("returns to manual entry when scanning is cancelled", async () => {
    const user = userEvent.setup();
    render(<BookImportModal />);

    await user.click(screen.getByRole("button", { name: "Scan barcode" }));
    await user.click(
      screen.getByRole("button", { name: "Cancel mock scanner" }),
    );

    expect(screen.queryByTestId("mock-book-scanner")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "ISBN" })).toHaveFocus();
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
