import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BaseCsvActions } from "#/components/bases/BaseCsvActions";

function renderActions() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BaseCsvActions
        slug="books"
        view="Reading"
        query={{ columns: ["title"] }}
      />
    </QueryClientProvider>,
  );
}

describe("Base CSV actions", () => {
  it("requires a server preview and explicit approval before importing pasted rows", async () => {
    const user = userEvent.setup();
    renderActions();
    await user.click(screen.getByRole("button", { name: "Import CSV" }));
    const dialog = screen.getByRole("dialog", { name: "Import CSV" });
    expect(
      within(dialog).getByRole("button", { name: "Preview CSV" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Import rows" }),
    ).toBeDisabled();
    await user.type(
      within(dialog).getByRole("textbox", { name: "CSV content" }),
      "Title,Score\nDune,5",
    );
    expect(
      within(dialog).getByRole("button", { name: "Preview CSV" }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Import rows" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(
        /No pages or property declarations are written by preview/,
      ),
    ).toBeVisible();
  });

  it("preserves unfinished input when the dialog is closed and reopened", async () => {
    const user = userEvent.setup();
    renderActions();
    await user.click(screen.getByRole("button", { name: "Import CSV" }));
    await user.type(
      screen.getByRole("textbox", { name: "CSV content" }),
      "title\nDune",
    );
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await user.click(screen.getByRole("button", { name: "Import CSV" }));
    expect(screen.getByRole("textbox", { name: "CSV content" })).toHaveValue(
      "title\nDune",
    );
    expect(screen.getByRole("button", { name: "Import rows" })).toBeDisabled();
  });
});
