import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
        <a {...{ role: "link" as const }} tabIndex={0}>
          Unwritten Page
        </a>
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

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
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

  it("composes the trigger's existing handler and ref with popover behavior", async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    const triggerRef = vi.fn();
    render(
      <MissingWikilinkPopover
        target="Unwritten Page"
        readOnly={false}
        creating={false}
        error={null}
        onCreate={async () => true}
      >
        <a
          {...{
            ref: triggerRef,
            role: "link" as const,
            onFocus,
          }}
          tabIndex={0}
        >
          Unwritten Page
        </a>
      </MissingWikilinkPopover>,
    );

    const trigger = screen.getByRole("link", { name: "Unwritten Page" });
    await user.tab();

    expect(onFocus).toHaveBeenCalledOnce();
    expect(triggerRef).toHaveBeenCalledWith(trigger);
    expect(
      screen.getByRole("dialog", { name: "Unwritten Page" }),
    ).toBeVisible();
  });

  it("keeps the dialog open while focus moves from the trigger into its action", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.tab();
    await user.tab();

    expect(screen.getByRole("button", { name: "Create page" })).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("keeps the dialog open through the pointer corridor and closes outside it", async () => {
    const { trigger } = renderPopover();
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(
      rect(100, 100, 100, 20),
    );

    fireEvent.mouseEnter(trigger, { clientX: 150, clientY: 110 });
    let dialog = await screen.findByRole("dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(
      rect(100, 44, 200, 50),
    );

    fireEvent.mouseLeave(trigger, {
      clientX: 150,
      clientY: 100,
      relatedTarget: document.body,
    });
    fireEvent.mouseMove(document.body, { clientX: 150, clientY: 98 });
    fireEvent.mouseMove(document.body, { clientX: 150, clientY: 96 });
    fireEvent.mouseMove(dialog, { clientX: 150, clientY: 93 });
    fireEvent.mouseEnter(dialog, { clientX: 150, clientY: 93 });

    dialog = screen.getByRole("dialog");
    expect(dialog).toBeVisible();

    fireEvent.mouseLeave(dialog, {
      clientX: 150,
      clientY: 44,
      relatedTarget: document.body,
    });
    fireEvent.mouseMove(document.body, { clientX: 400, clientY: 44 });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("shows the editable action and closes only after creation resolves true", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => true);
    renderPopover({ onCreate });

    await user.tab();
    await user.click(screen.getByRole("button", { name: "Create page" }));

    expect(onCreate).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
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
    expect(
      screen.queryByRole("button", { name: "Create page" }),
    ).not.toBeInTheDocument();
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

  it("dismisses on Escape, restores focus, and re-enables focus opening", async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover({ withOutsideTarget: true });

    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Create page" })).toHaveFocus();
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();

    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    await user.tab({ shift: true });

    expect(trigger).toHaveFocus();
    expect(
      screen.getByRole("dialog", { name: "Unwritten Page" }),
    ).toBeVisible();
  });

  it("dismisses on outside pointer interaction", async () => {
    const user = userEvent.setup();
    renderPopover({ withOutsideTarget: true });

    await user.tab();
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
