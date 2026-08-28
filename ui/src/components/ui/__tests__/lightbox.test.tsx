import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type KeyboardEvent, useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Lightbox } from "#/components/ui/lightbox";

interface HarnessProps {
  onParentKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Called with the transform the commit just painted. See `Picture`. */
  onCommit?: (transform: string) => void;
}

/**
 * The lightbox's child. Its layout effect runs inside the commit that put the
 * stage on screen and ahead of the lightbox's own passive effects, so what it
 * records is the transform the first frame really painted.
 */
function Picture({ onCommit }: { onCommit?: (transform: string) => void }) {
  useLayoutEffect(() => {
    const content = document.querySelector<HTMLElement>(
      '[data-testid="lightbox-content"]',
    );
    onCommit?.(content?.style.transform ?? "");
  });
  return (
    <svg data-testid="pic">
      <title>Picture</title>
    </svg>
  );
}

function Harness({ onParentKeyDown, onCommit }: HarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a probe for React event propagation, not a control.
    <div onKeyDown={onParentKeyDown}>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Lightbox isOpen={open} onOpenChange={setOpen} label="Diagram">
        <Picture onCommit={onCommit} />
      </Lightbox>
    </div>
  );
}

async function openLightbox(props: HarnessProps = {}) {
  const user = userEvent.setup();
  render(<Harness {...props} />);
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

  it("paints an identity transform on the first frame of a reopen", async () => {
    const commits: string[] = [];
    const { user, trigger } = await openLightbox({
      onCommit: (transform) => commits.push(transform),
    });

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("lightbox-content").style.transform).toContain(
      "scale(1.25)",
    );

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    commits.length = 0;

    await user.click(trigger);

    await screen.findByRole("dialog", { name: "Diagram" });
    expect(commits[0]).toBe("translate(0px, 0px) scale(1)");
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  // The shield over the dialog stops keys reaching the page around it — but
  // React Aria contains Tab on a listener of its own on `document`, which a
  // synthetic stopPropagation() would cut off, letting focus leave the dialog.
  it.each([
    { key: "a", reachesPage: false, closes: false },
    { key: "Escape", reachesPage: false, closes: true },
    { key: "Tab", reachesPage: true, closes: false },
  ])(
    "$key on the stage: reaches the page $reachesPage, closes $closes",
    async ({ key, reachesPage, closes }) => {
      const onParentKeyDown = vi.fn();
      await openLightbox({ onParentKeyDown });
      onParentKeyDown.mockClear();

      fireEvent.keyDown(screen.getByTestId("lightbox-stage"), { key });

      expect(onParentKeyDown).toHaveBeenCalledTimes(reachesPage ? 1 : 0);
      if (closes) {
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else {
        expect(
          screen.getByRole("dialog", { name: "Diagram" }),
        ).toBeInTheDocument();
      }
    },
  );
});
