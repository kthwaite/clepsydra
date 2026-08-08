import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => vi.fn(),
}));

describe("MarkdownRenderer", () => {
  it("copies a fenced code block's text via its copy button", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<MarkdownRenderer content={"```js\nconst answer = 42;\n```"} />);

    await user.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("const answer = 42;"),
      ),
    );
  });

  it("does not add a copy button to inline code", () => {
    render(<MarkdownRenderer content={"some `inline` code"} />);
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("marks recognized external resources without changing their accessible name", () => {
    render(
      <MarkdownRenderer
        content={
          "[Wikipedia](https://en.wikipedia.org/wiki/Hypertext) and [ordinary](https://example.com)"
        }
      />,
    );

    const wikipedia = screen.getByRole("link", { name: "Wikipedia" });
    expect(wikipedia).toHaveAttribute("data-link-resource", "wikipedia");
    expect(wikipedia).toHaveTextContent("Wikipedia");
    expect(screen.getByRole("link", { name: "ordinary" })).not.toHaveAttribute(
      "data-link-resource",
    );
  });

  it("does not mark internal page links", () => {
    render(<MarkdownRenderer content="[Local](/pages/notes/local.md)" />);
    expect(screen.getByRole("link", { name: "Local" })).not.toHaveAttribute(
      "data-link-resource",
    );
  });
});
