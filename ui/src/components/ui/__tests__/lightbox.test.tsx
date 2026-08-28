import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type KeyboardEvent, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Lightbox } from "#/components/ui/lightbox";

function Harness({
  onParentKeyDown,
}: {
  onParentKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a probe for React event propagation, not a control.
    <div onKeyDown={onParentKeyDown}>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Lightbox isOpen={open} onOpenChange={setOpen} label="Diagram">
        <svg data-testid="pic">
          <title>Picture</title>
        </svg>
      </Lightbox>
    </div>
  );
}

async function openLightbox(
  onParentKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void,
) {
  const user = userEvent.setup();
  render(<Harness onParentKeyDown={onParentKeyDown} />);
  const trigger = screen.getByRole("button", { name: "Open" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Diagram" });
  return { user, trigger, dialog };
}

describe("Lightbox", () => {
  it("shows the child in a labelled dialog and returns focus on Escape", async () => {
    const { user, trigger, dialog } = await openLightbox();

    expect(within(dialog).getByTestId("pic")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // React Aria restores focus on the frame after the overlay unmounts.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("zooms in, zooms out and resets the stage transform", async () => {
    const { user } = await openLightbox();
    const content = screen.getByTestId("lightbox-content");

    expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(content.style.transform).toContain("scale(1.25)");
    expect(screen.getByText("125%")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom out" }));

    expect(screen.getByText("100%")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(content.style.transform).toContain("scale(1.25)");

    await user.click(screen.getByRole("button", { name: "Reset view" }));

    expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("closes from the Close control", async () => {
    const { user } = await openLightbox();

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps keys pressed on the stage inside the dialog", async () => {
    const onParentKeyDown = vi.fn();
    await openLightbox(onParentKeyDown);
    onParentKeyDown.mockClear();

    fireEvent.keyDown(screen.getByTestId("lightbox-stage"), { key: "a" });

    expect(onParentKeyDown).not.toHaveBeenCalled();
  });
});
