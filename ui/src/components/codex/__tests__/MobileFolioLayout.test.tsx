import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/components/codex/ReadingProgressContext", () => ({
  useReadingProgress: () => ({ progress: 0.38, setProgress: () => {} }),
}));

import { useMobileChrome } from "#/store/mobileChrome";
import {
  MobileFolioLayout,
  type MobileFolioLayoutProps,
} from "../MobileFolioLayout";

function renderLayout(overrides: Partial<MobileFolioLayoutProps> = {}) {
  const props: MobileFolioLayoutProps = {
    header: <div>Dossier header</div>,
    document: <div>Editable document</div>,
    details: <div>Document metadata</div>,
    relationships: <div>Backlinks</div>,
    contents: <div>Page contents</div>,
    onBack: vi.fn(),
    group: null,
    status: <span>Saved</span>,
    linkedCount: 3,
    ...overrides,
  };
  return { props, ...render(<MobileFolioLayout {...props} />) };
}

const bar = () => screen.getByRole("navigation", { name: "Page controls" });

describe("MobileFolioLayout", () => {
  it("renders the document column and delegates Back", async () => {
    const onBack = vi.fn();
    renderLayout({ onBack });

    const main = screen.getByRole("main", { name: "Page document" });
    expect(main).toHaveTextContent("Dossier header");
    expect(main).toHaveTextContent("Editable document");
    expect(screen.queryByText("Document metadata")).not.toBeInTheDocument();

    await userEvent.click(within(bar()).getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows the group label and save state in the page bar", () => {
    renderLayout({
      group: { name: "Research", color: "var(--quire-ochre)" },
    });
    expect(bar()).toHaveTextContent("Research");
    expect(bar()).toHaveTextContent("Saved");
  });

  it("omits the group label for a loose page", () => {
    renderLayout();
    expect(bar()).not.toHaveTextContent("Research");
  });

  it("opens the details sheet on Outline with Properties and Linked tabs", async () => {
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: "Page details" }));
    const sheet = screen.getByRole("dialog", { name: "Page details" });

    expect(within(sheet).getByRole("tab", { name: "Outline" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(sheet).toHaveTextContent("Page contents");

    await userEvent.click(
      within(sheet).getByRole("tab", { name: "Properties" }),
    );
    expect(sheet).toHaveTextContent("Document metadata");

    await userEvent.click(
      within(sheet).getByRole("tab", { name: "Linked · 3" }),
    );
    expect(sheet).toHaveTextContent("Backlinks");
  });

  it("closes the sheet after an outline jump", async () => {
    renderLayout({ contents: <button type="button">Heading one</button> });
    await userEvent.click(screen.getByRole("button", { name: "Page details" }));
    await userEvent.click(screen.getByRole("button", { name: "Heading one" }));
    expect(
      screen.queryByRole("dialog", { name: "Page details" }),
    ).not.toBeInTheDocument();
  });

  it("claims the top bar while mounted", () => {
    const { unmount } = renderLayout();
    expect(useMobileChrome.getState().ownBar).toBe(true);
    unmount();
    expect(useMobileChrome.getState().ownBar).toBe(false);
  });

  it("draws reading progress above the bottom bar", () => {
    renderLayout();
    const fill = screen.getByTestId("reading-progress")
      .firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("38%");
  });

  it("sizes text fields without stretching checkbox and radio controls", async () => {
    const { container } = renderLayout({
      document: (
        <>
          <input aria-label="Title" type="text" />
          <input aria-label="Complete" type="checkbox" />
        </>
      ) as ReactNode,
      details: <input aria-label="Detail title" type="text" />,
    });

    const layout = container.firstElementChild;
    expect(layout).toHaveClass(
      "[&_input:not([type=checkbox]):not([type=radio])]:min-h-11",
      "[&_select]:min-h-11",
    );
    expect(layout).not.toHaveClass("[&_input]:min-h-11");

    await userEvent.click(screen.getByRole("button", { name: "Page details" }));
    const modal = screen
      .getByRole("dialog", { name: "Page details" })
      .closest(".rounded-t-3xl");
    expect(modal).toHaveClass(
      "[&_input:not([type=checkbox]):not([type=radio])]:min-h-11",
      "[&_select]:min-h-11",
    );
    expect(modal).not.toHaveClass("[&_input]:min-h-11");
  });
});
