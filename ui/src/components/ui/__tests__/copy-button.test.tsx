import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopyButton } from "#/components/ui/CopyButton";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("CopyButton", () => {
  it("renders an accessible copy button", () => {
    render(<CopyButton getText={() => "x"} />);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("copies the text returned by getText when pressed", async () => {
    // userEvent.setup() installs its own navigator.clipboard stub, so spy on
    // it afterwards rather than supplying our own mock.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<CopyButton getText={() => "payload-123"} />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("payload-123"));
  });

  it("reflects the copied state on the button's accessible name", async () => {
    const user = userEvent.setup();
    render(<CopyButton getText={() => "payload"} />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied" }),
      ).toBeInTheDocument(),
    );
  });

  it("accepts a custom label as the accessible name", () => {
    render(<CopyButton getText={() => "x"} label="Copy code" />);
    expect(
      screen.getByRole("button", { name: "Copy code" }),
    ).toBeInTheDocument();
  });

  it("reveals a tooltip with the label on focus", async () => {
    const user = userEvent.setup();
    render(<CopyButton getText={() => "x"} label="Copy code" />);

    await user.tab();

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy code");
  });
});
