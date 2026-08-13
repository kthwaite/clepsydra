import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MissingWikilinkPopover } from "#/editor/MissingWikilinkPopover";

interface RenderPopoverOptions {
  readOnly?: boolean;
  creating?: boolean;
  error?: string | null;
  onCreate?: () => Promise<boolean>;
  withOutsideTarget?: boolean;
}

function renderPopover({
  readOnly = false,
  creating = false,
  error = null,
  onCreate = vi.fn(async () => true),
  withOutsideTarget = false,
}: RenderPopoverOptions = {}) {
  const view = render(
    <>
      <MissingWikilinkPopover
        target="Unwritten Page"
        readOnly={readOnly}
        creating={creating}
        error={error}
        onCreate={onCreate}
      >
        <span role="link" tabIndex={0}>
          Unwritten Page
        </span>
      </MissingWikilinkPopover>
      {withOutsideTarget ? <button type="button">Outside</button> : null}
    </>,
  );

  return {
    ...view,
    trigger: screen.getByRole("link", { name: "Unwritten Page" }),
    onCreate,
  };
}

describe("MissingWikilinkPopover", () => {
  it("opens an accessible missing-page dialog when the trigger receives focus", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    await user.tab();

    expect(trigger).toHaveFocus();
    const dialog = screen.getByRole("dialog", { name: "Unwritten Page" });
    expect(dialog).toHaveTextContent("Missing page");
    expect(dialog).toHaveTextContent("Page does not exist.");
  });

  it("keeps the dialog open while focus moves from the trigger into its action", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.tab();
    await user.tab();

    expect(screen.getByRole("button", { name: "Create page" })).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("keeps the dialog open during pointer transfer from trigger to surface", async () => {
    const { trigger } = renderPopover();

    fireEvent.mouseEnter(trigger, { clientX: 10, clientY: 10 });
    const dialog = await screen.findByRole("dialog");
    fireEvent.mouseLeave(trigger, {
      clientX: 12,
      clientY: 12,
      relatedTarget: dialog,
    });
    fireEvent.mouseEnter(dialog, { clientX: 14, clientY: 14 });

    expect(dialog).toBeVisible();
  });

  it("shows the editable action and closes only after creation resolves true", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => true);
    renderPopover({ onCreate });

    await user.tab();
    await user.click(screen.getByRole("button", { name: "Create page" }));

    expect(onCreate).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the retry surface open when creation resolves false", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => false);
    renderPopover({ onCreate });

    await user.tab();
    await user.click(screen.getByRole("button", { name: "Create page" }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create page" })).toBeEnabled();
  });

  it("hides the creation action in read-only mode", async () => {
    const user = userEvent.setup();
    renderPopover({ readOnly: true });

    await user.tab();

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create page" })).not.toBeInTheDocument();
  });

  it("disables duplicate activation while creation is pending", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => true);
    renderPopover({ creating: true, onCreate });

    await user.tab();
    const action = screen.getByRole("button", { name: "Creating…" });
    expect(action).toBeDisabled();
    await user.click(action);

    expect(onCreate).not.toHaveBeenCalled();
  });

  it("shows creation errors while leaving the action retryable", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => false);
    renderPopover({ error: "Creation failed", onCreate });

    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Creation failed");
    const action = screen.getByRole("button", { name: "Create page" });
    expect(action).toBeEnabled();
    await user.click(action);

    expect(onCreate).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("dismisses on Escape and restores focus to the link trigger", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Create page" })).toHaveFocus();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("dismisses on outside pointer interaction", async () => {
    const user = userEvent.setup();
    renderPopover({ withOutsideTarget: true });

    await user.tab();
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
