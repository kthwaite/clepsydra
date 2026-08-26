import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MobileFolioLayout } from "../MobileFolioLayout";

describe("MobileFolioLayout", () => {
  it("renders a focused document column and delegates back navigation", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();

    render(
      <MobileFolioLayout
        header={<div>Dossier header</div>}
        document={<div>Editable document</div>}
        details={<div>Document metadata</div>}
        relationships={<div>Backlinks</div>}
        contents={<div>Page contents</div>}
        onBack={onBack}
      />,
    );

    const document = screen.getByRole("main", { name: "Page document" });
    expect(document).toHaveTextContent("Dossier header");
    expect(document).toHaveTextContent("Editable document");
    expect(screen.queryByText("Document metadata")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("exposes details, contents, and relationships in named modal sheets", async () => {
    const user = userEvent.setup();

    render(
      <MobileFolioLayout
        header={<div>Dossier header</div>}
        document={<div>Editable document</div>}
        details={<div>Document metadata</div>}
        relationships={<div>Backlinks</div>}
        contents={<div>Page contents</div>}
        onBack={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Document details" }));
    const details = screen.getByRole("dialog", { name: "Document details" });
    expect(details).toHaveTextContent("Document metadata");
    expect(details).toHaveTextContent("Page contents");

    await user.click(
      screen.getByRole("button", { name: "Page relationships" }),
    );
    const relationships = screen.getByRole("dialog", {
      name: "Page relationships",
    });
    expect(relationships).toHaveTextContent("Backlinks");
    expect(
      screen.queryByRole("dialog", { name: "Document details" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Close page relationships" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Page relationships" }),
    ).not.toBeInTheDocument();
  });

  it("sizes text fields without stretching checkbox and radio controls", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MobileFolioLayout
        header={<div>Dossier header</div>}
        document={
          <>
            <input aria-label="Title" type="text" />
            <input aria-label="Complete" type="checkbox" />
            <input aria-label="Choice" type="radio" />
          </>
        }
        details={<input aria-label="Detail title" type="text" />}
        relationships={<div>Backlinks</div>}
        contents={<input aria-label="Detail choice" type="checkbox" />}
        onBack={vi.fn()}
      />,
    );

    const layout = container.firstElementChild;
    expect(layout).toHaveClass(
      "[&_input:not([type=checkbox]):not([type=radio])]:min-h-11",
      "[&_select]:min-h-11",
    );
    expect(layout).not.toHaveClass("[&_input]:min-h-11");

    await user.click(screen.getByRole("button", { name: "Document details" }));
    const dialog = screen.getByRole("dialog", { name: "Document details" });
    expect(dialog).toHaveClass(
      "[&_input:not([type=checkbox]):not([type=radio])]:min-h-11",
      "[&_select]:min-h-11",
    );
    expect(dialog).not.toHaveClass("[&_input]:min-h-11");
  });
});
