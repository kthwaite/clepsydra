import { render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "#/components/ThemeProvider";
import { Toaster } from "#/components/ui/Toaster";

describe("Toaster", () => {
  it("displays toasts anchored at the bottom-right", async () => {
    render(
      <ThemeProvider>
        <Toaster />
      </ThemeProvider>,
    );

    toast("logged");

    await waitFor(() => expect(screen.getByText("logged")).toBeInTheDocument());

    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toHaveAttribute("data-y-position", "bottom");
    expect(toaster).toHaveAttribute("data-x-position", "right");
  });
});
