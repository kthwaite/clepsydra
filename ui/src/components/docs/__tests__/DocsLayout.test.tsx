import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocsLayout } from "#/components/docs/DocsLayout";

vi.mock("#/components/docs/DocsSidebar", () => ({
  DocsSidebar: ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav aria-label="Documentation">
      <button type="button" onClick={onNavigate}>
        Mock guide
      </button>
    </nav>
  ),
}));

describe("DocsLayout", () => {
  it("keeps a persistent desktop rail and independently scrollable article", () => {
    render(
      <DocsLayout activeSlug="getting-started">
        <article>Article content</article>
      </DocsLayout>,
    );

    const rail = screen.getByTestId("docs-desktop-rail");
    expect(rail).toHaveClass("hidden", "md:flex");
    expect(
      within(rail).getByRole("navigation", { name: "Documentation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("main", { name: "Documentation article" }),
    ).toHaveClass("overflow-y-auto");
    expect(screen.getByText("Article content")).toBeInTheDocument();
  });

  it("opens a labeled dismissible narrow drawer without unmounting the article", async () => {
    const user = userEvent.setup();
    render(
      <DocsLayout>
        <article>Article remains mounted</article>
      </DocsLayout>,
    );

    await user.click(
      screen.getByRole("button", { name: "Open documentation navigation" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Documentation navigation" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Article remains mounted")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Documentation navigation" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Article remains mounted")).toBeInTheDocument();
  });

  it("closes the narrow drawer after sidebar navigation", async () => {
    const user = userEvent.setup();
    render(
      <DocsLayout>
        <article>Article content</article>
      </DocsLayout>,
    );

    await user.click(
      screen.getByRole("button", { name: "Open documentation navigation" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Documentation navigation",
    });
    await user.click(within(dialog).getByRole("button", { name: "Mock guide" }));
    expect(
      screen.queryByRole("dialog", { name: "Documentation navigation" }),
    ).not.toBeInTheDocument();
  });
});
