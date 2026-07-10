import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CodexModalShell } from "#/components/codex/CodexModalShell";

function ModalHarness({ onDismiss }: { onDismiss: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open && (
        <CodexModalShell
          ariaLabel="Test Codex Dialog"
          maxWidthClassName="max-w-[520px]"
          onDismiss={() => {
            onDismiss();
            setOpen(false);
          }}
        >
          <input
            aria-label="Consumes Escape"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          />
          <button type="button">Dialog action</button>
        </CodexModalShell>
      )}
    </>
  );
}

describe("CodexModalShell", () => {
  it("exposes a named dialog and dismisses on Escape", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ModalHarness onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(
      screen.getByRole("dialog", { name: "Test Codex Dialog" }),
    ).toBeVisible();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss when a focused child consumes Escape", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ModalHarness onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    const input = screen.getByRole("textbox", { name: "Consumes Escape" });
    await user.click(input);
    await user.keyboard("{Escape}");

    expect(onDismiss).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it("dismisses from the backdrop and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ModalHarness onDismiss={onDismiss} />);

    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    await user.click(trigger);
    expect(trigger).not.toHaveFocus();

    const overlay = document.body.querySelector(".fixed.inset-0");
    expect(overlay).toBeInstanceOf(HTMLElement);
    await user.click(overlay as HTMLElement);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
