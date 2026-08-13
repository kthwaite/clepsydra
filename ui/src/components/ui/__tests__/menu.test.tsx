import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Selection } from "react-aria-components/Menu";
import { describe, expect, it, vi } from "vitest";
import { Button } from "#/components/ui/button";
import {
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from "#/components/ui/menu";

function SelectionFixture({
  selectionMode,
}: {
  selectionMode: "single" | "multiple";
}) {
  const [selectedKeys, setSelectedKeys] = useState<Selection>(
    new Set(["alpha"]),
  );

  return (
    <MenuTrigger>
      <Button>Choose labels</Button>
      <Menu
        aria-label="Labels"
        selectionMode={selectionMode}
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        shouldCloseOnSelect={false}
      >
        <MenuItem id="alpha">Alpha</MenuItem>
        <MenuItem id="beta">Beta</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

function expectSelectedIndicator(item: HTMLElement) {
  expect(
    item.querySelector("[aria-hidden='true']:not(:empty)"),
  ).toBeInTheDocument();
}

describe("Menu", () => {
  it("opens from an ordinary press trigger and dispatches an action", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <MenuTrigger>
        <Button>Open actions</Button>
        <Menu aria-label="Actions" onAction={onAction}>
          <MenuItem id="open">Open</MenuItem>
        </Menu>
      </MenuTrigger>,
    );

    await user.click(screen.getByRole("button", { name: "Open actions" }));
    expect(
      await screen.findByRole("menu", { name: "Open actions" }),
    ).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onAction.mock.calls[0]?.[0]).toBe("open");
  });

  it("opens from a native context target and dispatches an action", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ContextMenuTrigger>
        <button type="button">Target</button>
        <Menu aria-label="Actions" onAction={onAction}>
          <MenuItem id="open">Open</MenuItem>
        </Menu>
      </ContextMenuTrigger>,
    );

    await user.pointer({
      target: screen.getByRole("button", { name: "Target" }),
      keys: "[MouseRight]",
    });
    expect(
      await screen.findByRole("menu", { name: "Target" }),
    ).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onAction.mock.calls[0]?.[0]).toBe("open");
  });

  it("opens, navigates, and activates a context menu from the keyboard", async () => {
    const platformSpy = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("MacIntel");

    try {
      const user = userEvent.setup();
      const onAction = vi.fn();
      render(
        <ContextMenuTrigger>
          <button type="button">Keyboard target</button>
          <Menu aria-label="Keyboard actions" onAction={onAction}>
            <MenuItem id="open">Open</MenuItem>
            <MenuItem id="rename">Rename</MenuItem>
          </Menu>
        </ContextMenuTrigger>,
      );

      const target = screen.getByRole("button", { name: "Keyboard target" });
      await user.click(target);
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(
        await screen.findByRole("menu", { name: "Keyboard target" }),
      ).toBeVisible();

      await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
      expect(onAction.mock.calls[0]?.[0]).toBe("rename");
      expect(
        screen.queryByRole("menu", { name: "Keyboard target" }),
      ).not.toBeInTheDocument();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("exposes disabled state and prevents disabled item actions", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ContextMenuTrigger>
        <button type="button">Disabled target</button>
        <Menu aria-label="Disabled actions" onAction={onAction}>
          <MenuItem id="delete" isDisabled>
            Delete
          </MenuItem>
        </Menu>
      </ContextMenuTrigger>,
    );

    await user.pointer({
      target: screen.getByRole("button", { name: "Disabled target" }),
      keys: "[MouseRight]",
    });
    const item = await screen.findByRole("menuitem", { name: "Delete" });
    expect(item).toHaveAttribute("aria-disabled", "true");

    await user.click(item);
    expect(onAction).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("menu", { name: "Disabled target" }),
    ).toBeVisible();
  });

  it("exposes the destructive item variant", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenuTrigger>
        <button type="button">Destructive target</button>
        <Menu aria-label="Destructive actions">
          <MenuItem id="delete" variant="destructive">
            Delete permanently
          </MenuItem>
        </Menu>
      </ContextMenuTrigger>,
    );

    await user.pointer({
      target: screen.getByRole("button", { name: "Destructive target" }),
      keys: "[MouseRight]",
    });

    expect(
      await screen.findByRole("menuitem", { name: "Delete permanently" }),
    ).toHaveAttribute("data-variant", "destructive");
  });

  it("renders and updates a controlled single selection", async () => {
    const user = userEvent.setup();
    render(<SelectionFixture selectionMode="single" />);

    await user.click(screen.getByRole("button", { name: "Choose labels" }));
    const alpha = await screen.findByRole("menuitemradio", { name: "Alpha" });
    const beta = await screen.findByRole("menuitemradio", { name: "Beta" });
    expect(alpha).toHaveAttribute("aria-checked", "true");
    expect(beta).toHaveAttribute("aria-checked", "false");
    expectSelectedIndicator(alpha);

    await user.click(beta);
    expect(alpha).toHaveAttribute("aria-checked", "false");
    expect(beta).toHaveAttribute("aria-checked", "true");
    expectSelectedIndicator(beta);
  });

  it("renders and updates a controlled multiple selection", async () => {
    const user = userEvent.setup();
    render(<SelectionFixture selectionMode="multiple" />);

    await user.click(screen.getByRole("button", { name: "Choose labels" }));
    const alpha = await screen.findByRole("menuitemcheckbox", {
      name: "Alpha",
    });
    const beta = await screen.findByRole("menuitemcheckbox", { name: "Beta" });
    expect(alpha).toHaveAttribute("aria-checked", "true");
    expect(beta).toHaveAttribute("aria-checked", "false");

    await user.click(beta);
    expect(alpha).toHaveAttribute("aria-checked", "true");
    expect(beta).toHaveAttribute("aria-checked", "true");
    expectSelectedIndicator(alpha);
    expectSelectedIndicator(beta);
  });

  it("opens a submenu with ArrowRight and activates its child", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ContextMenuTrigger>
        <button type="button">Submenu target</button>
        <Menu aria-label="Main actions">
          <SubmenuTrigger>
            <MenuItem id="more">More</MenuItem>
            <Menu aria-label="More actions" onAction={onAction}>
              <MenuItem id="duplicate">Duplicate</MenuItem>
            </Menu>
          </SubmenuTrigger>
        </Menu>
      </ContextMenuTrigger>,
    );

    await user.pointer({
      target: screen.getByRole("button", { name: "Submenu target" }),
      keys: "[MouseRight]",
    });
    await user.keyboard("{ArrowDown}");
    const more = await screen.findByRole("menuitem", { name: "More" });
    await waitFor(() => expect(more).toHaveFocus());

    await user.keyboard("{ArrowRight}");
    expect(
      await screen.findByRole("menu", { name: "More" }),
    ).toBeVisible();

    await user.keyboard("{Enter}");
    expect(onAction.mock.calls[0]?.[0]).toBe("duplicate");
  });

  it("renders structured sections and rich item semantics", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenuTrigger>
        <button type="button">Structured target</button>
        <Menu aria-label="Structured actions">
          <MenuSection aria-label="File actions">
            <MenuItem
              id="archive"
              icon={<svg data-testid="archive-icon" />}
              description="Moves this item to the archive"
              shortcut="⌘⇧A"
            >
              Archive
            </MenuItem>
          </MenuSection>
          <MenuSeparator />
          <MenuSection aria-label="Label actions">
            <MenuItem
              id="blue"
              swatch="rgb(0, 0, 255)"
            >
              Blue label
            </MenuItem>
          </MenuSection>
        </Menu>
      </ContextMenuTrigger>,
    );

    await user.pointer({
      target: screen.getByRole("button", { name: "Structured target" }),
      keys: "[MouseRight]",
    });
    await screen.findByRole("menu", { name: "Structured target" });

    expect(
      screen.getByRole("group", { name: "File actions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Label actions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();

    const archive = screen.getByRole("menuitem", { name: "Archive" });
    expect(archive).toHaveAccessibleDescription(
      "Moves this item to the archive ⌘⇧A",
    );
    const shortcut = within(archive).getByText("⌘⇧A");
    expect(shortcut.tagName).toBe("KBD");
    expect(shortcut.closest("[aria-hidden='true']")).toBeNull();
    expect(
      screen.getByTestId("archive-icon").closest("[aria-hidden='true']"),
    ).not.toBeNull();

    const blue = screen.getByRole("menuitem", { name: "Blue label" });
    expect(blue).toHaveAccessibleName("Blue label");
    const swatch = blue.querySelector<HTMLElement>("[data-slot='swatch']");
    expect(swatch).toHaveAttribute("aria-hidden", "true");
    expect(swatch).toHaveStyle({ backgroundColor: "rgb(0, 0, 255)" });
  });

  it("dismisses with Escape", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenuTrigger>
        <button type="button">Escape target</button>
        <Menu aria-label="Escape actions">
          <MenuItem id="open">Open</MenuItem>
        </Menu>
      </ContextMenuTrigger>,
    );

    const target = screen.getByRole("button", { name: "Escape target" });
    await user.pointer({ target, keys: "[MouseRight]" });
    expect(
      await screen.findByRole("menu", { name: "Escape target" }),
    ).toBeVisible();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("menu", { name: "Escape target" }),
    ).not.toBeInTheDocument();
  });
});
