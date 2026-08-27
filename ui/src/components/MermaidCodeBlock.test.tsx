import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidCodeBlock } from "#/components/MermaidCodeBlock";

const { renderMock } = vi.hoisted(() => ({ renderMock: vi.fn() }));

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const SOURCE = "graph TD;\n  a-->b;";

function source(): HTMLPreElement {
  const pre = document.querySelector("pre");
  if (!pre) throw new Error("no source element rendered");
  return pre;
}

beforeEach(() => {
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: "<svg data-testid='svg'></svg>" });
});

describe("MermaidCodeBlock", () => {
  it("renders the diagram and keeps the source out of sight", async () => {
    render(<MermaidCodeBlock code={SOURCE} />);

    await screen.findByTestId("mermaid-diagram");
    expect(renderMock).toHaveBeenCalledWith(expect.any(String), SOURCE);
    expect(source()).toHaveClass("sr-only");
    expect(source()).toHaveTextContent("graph TD;");
  });

  it("toggles to the raw source and back to the diagram", async () => {
    const user = userEvent.setup();
    render(<MermaidCodeBlock code={SOURCE} />);
    await screen.findByTestId("mermaid-diagram");

    const toggle = screen.getByRole("button", { name: "Show diagram" });
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
    expect(source()).not.toHaveClass("sr-only");

    await user.click(toggle);

    await screen.findByTestId("mermaid-diagram");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(source()).toHaveClass("sr-only");
  });

  it("falls back to the source with the error when mermaid cannot parse", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    render(<MermaidCodeBlock code={"graph TD;\n  a-->"} />);

    await waitFor(() =>
      expect(screen.getByTestId("mermaid-error")).toHaveTextContent(
        "Parse error on line 2",
      ),
    );
    expect(source()).not.toHaveClass("sr-only");
  });

  it("copies the mermaid source", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<MermaidCodeBlock code={SOURCE} />);

    await user.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SOURCE));
  });
});
