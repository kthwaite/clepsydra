import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useWorkspaceStore } from "#/store/workspace";
import { type MenuTarget, SheafContextMenu } from "../SheafContextMenu";

function seed() {
  useWorkspaceStore.setState({
    tabs: [
      { id: "t1", type: "page", path: "a.md", label: "A" },
      { id: "t2", type: "page", path: "b.md", label: "B", quireId: "q1" },
    ],
    activeTabId: "t1",
    quires: {
      q1: { id: "q1", name: "thesis", color: "sepia", collapsed: false },
    },
    openHistory: [],
  });
}

async function renderMenu(target: MenuTarget) {
  const user = userEvent.setup();
  render(
    <SheafContextMenu target={target}>
      <button type="button">Target</button>
    </SheafContextMenu>,
  );

  await openMenu(user);
  return user;
}

async function openMenu(user: UserEvent) {
  await user.pointer({
    target: screen.getByRole("button", { name: "Target" }),
    keys: "[MouseRight]",
  });
  return screen.findByRole("menu", { name: "Target" });
}

async function expectRootMenuDismissed() {
  await waitFor(() =>
    expect(
      screen.queryByRole("menu", { name: "Target" }),
    ).not.toBeInTheDocument(),
  );
}

function quireNames() {
  return Object.values(useWorkspaceStore.getState().quires).map(
    (quire) => quire.name,
  );
}

describe("SheafContextMenu — tab target", () => {
  it("closes the target tab", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });

    await user.click(await screen.findByRole("menuitem", { name: "CLOSE" }));

    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "t2",
    ]);
  });

  it("closes the other tabs without exposing tab pin actions", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });
    const rootMenu = await screen.findByRole("menu", { name: "Target" });

    expect(
      within(rootMenu).queryByRole("menuitem", { name: /^(un)?pin$/i }),
    ).not.toBeInTheDocument();
    await user.click(
      within(rootMenu).getByRole("menuitem", { name: "CLOSE OTHERS" }),
    );

    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "t1",
    ]);
  });

  it("CLOSE ALL dismisses the menu and opens a confirmation without mutating the store", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });

    await user.click(
      await screen.findByRole("menuitem", { name: "CLOSE ALL" }),
    );

    await expectRootMenuDismissed();
    const dialog = await screen.findByRole("dialog", {
      name: "Close all tabs",
    });
    expect(dialog).toBeVisible();
    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(quireNames()).toEqual(["thesis"]);
  });

  it("cancelling the CLOSE ALL confirmation leaves tabs and quires unchanged", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });
    await user.click(
      await screen.findByRole("menuitem", { name: "CLOSE ALL" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Close all tabs",
    });

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(quireNames()).toEqual(["thesis"]);
    expect(
      screen.queryByRole("dialog", { name: "Close all tabs" }),
    ).not.toBeInTheDocument();
  });

  it("confirming CLOSE ALL empties the workspace and closes the dialog", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });
    await user.click(
      await screen.findByRole("menuitem", { name: "CLOSE ALL" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Close all tabs",
    });

    await user.click(within(dialog).getByRole("button", { name: "Close all" }));

    const state = useWorkspaceStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.quires).toEqual({});
    expect(
      screen.queryByRole("dialog", { name: "Close all tabs" }),
    ).not.toBeInTheDocument();
  });

  it("adds the tab through the ADD TO QUIRE submenu", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });

    await user.click(
      await screen.findByRole("menuitem", { name: "ADD TO QUIRE" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "THESIS" }));

    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === "t1")?.quireId,
    ).toBe("q1");
  });

  it("removes a member from its quire", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t2" });

    await user.click(
      await screen.findByRole("menuitem", { name: "REMOVE FROM QUIRE" }),
    );

    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === "t2")?.quireId,
    ).toBeUndefined();
  });

  it("closes the menu and opens a compact New quire dialog", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });

    await user.click(
      await screen.findByRole("menuitem", { name: "NEW QUIRE…" }),
    );

    await expectRootMenuDismissed();
    const dialog = await screen.findByRole("dialog", { name: "New quire" });
    expect(dialog).toBeVisible();
    expect(dialog.parentElement).toHaveClass("max-w-sm");
  });

  it("keeps Create disabled for a whitespace-only quire name", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });
    await user.click(
      await screen.findByRole("menuitem", { name: "NEW QUIRE…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New quire" });

    await user.type(within(dialog).getByRole("textbox"), "   ");

    expect(
      within(dialog).getByRole("button", { name: "Create" }),
    ).toBeDisabled();
    expect(quireNames()).toEqual(["thesis"]);
  });

  it("trims a new quire name and creates it with Enter", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });
    await user.click(
      await screen.findByRole("menuitem", { name: "NEW QUIRE…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New quire" });

    await user.type(within(dialog).getByRole("textbox"), "  drafts  ");
    await user.keyboard("{Enter}");

    const { tabs, quires } = useWorkspaceStore.getState();
    const created = Object.values(quires).find(
      (quire) => quire.name === "drafts",
    );
    expect(created).toBeDefined();
    expect(tabs.find((tab) => tab.id === "t1")?.quireId).toBe(created?.id);
    expect(
      screen.queryByRole("dialog", { name: "New quire" }),
    ).not.toBeInTheDocument();
  });

  it("no-ops and dismisses when the target disappears before activation", async () => {
    seed();
    const user = await renderMenu({ kind: "tab", tabId: "t1" });
    const closeOthers = await screen.findByRole("menuitem", {
      name: "CLOSE OTHERS",
    });

    // Model the render-to-activation race without notifying React and unmounting
    // the open portal before its already-rendered action can be activated.
    const state = useWorkspaceStore.getState();
    state.tabs.splice(
      state.tabs.findIndex((tab) => tab.id === "t1"),
      1,
    );
    await user.click(closeOthers);

    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "t2",
    ]);
    await expectRootMenuDismissed();
  });
});

describe("SheafContextMenu — quire target", () => {
  it("opens a compact prefilled rename dialog and Escape leaves it unchanged", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });
    await user.click(await screen.findByRole("menuitem", { name: "RENAME…" }));

    const dialog = await screen.findByRole("dialog", { name: "Rename quire" });
    expect(dialog.parentElement).toHaveClass("max-w-sm");
    const field = within(dialog).getByRole("textbox");
    expect(field).toHaveValue("thesis");
    await user.clear(field);
    await user.type(field, "discarded");
    await user.keyboard("{Escape}");

    expect(useWorkspaceStore.getState().quires.q1.name).toBe("thesis");
    expect(
      screen.queryByRole("dialog", { name: "Rename quire" }),
    ).not.toBeInTheDocument();
  });

  it("cancels a rename without mutating the quire", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });
    await user.click(await screen.findByRole("menuitem", { name: "RENAME…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename quire" });
    const field = within(dialog).getByRole("textbox");
    await user.clear(field);
    await user.type(field, "discarded");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(useWorkspaceStore.getState().quires.q1.name).toBe("thesis");
    expect(
      screen.queryByRole("dialog", { name: "Rename quire" }),
    ).not.toBeInTheDocument();
  });

  it("trims and submits a renamed quire", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });
    await user.click(await screen.findByRole("menuitem", { name: "RENAME…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename quire" });
    const field = within(dialog).getByRole("textbox");
    await user.clear(field);
    await user.type(field, "  opus  ");

    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(useWorkspaceStore.getState().quires.q1.name).toBe("opus");
    expect(
      screen.queryByRole("dialog", { name: "Rename quire" }),
    ).not.toBeInTheDocument();
  });

  it("recolors the quire through COLOR and preserves the selected radio", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });

    await user.click(await screen.findByRole("menuitem", { name: "COLOR" }));
    expect(
      await screen.findByRole("menuitemradio", { name: "SEPIA" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(
      await screen.findByRole("menuitemradio", { name: "MADDER" }),
    );
    expect(useWorkspaceStore.getState().quires.q1.color).toBe("madder");

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "COLOR" }));
    expect(
      await screen.findByRole("menuitemradio", { name: "MADDER" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("collapses and expands the quire", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });

    await user.click(await screen.findByRole("menuitem", { name: "COLLAPSE" }));
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(true);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "EXPAND" }));
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(false);
  });

  it("ungroups the quire", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });

    await user.click(await screen.findByRole("menuitem", { name: "UNGROUP" }));

    const state = useWorkspaceStore.getState();
    expect(state.quires.q1).toBeUndefined();
    expect(state.tabs.find((tab) => tab.id === "t2")?.quireId).toBeUndefined();
  });

  it("marks CLOSE QUIRE destructive and closes every member", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });
    const closeQuire = await screen.findByRole("menuitem", {
      name: "CLOSE QUIRE",
    });

    expect(closeQuire).toHaveAttribute("data-variant", "destructive");
    await user.click(closeQuire);

    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "t1",
    ]);
  });

  it("offers CLOSE ALL TABS and confirming empties the workspace", async () => {
    seed();
    const user = await renderMenu({ kind: "quire", quireId: "q1" });

    await user.click(
      await screen.findByRole("menuitem", { name: "CLOSE ALL TABS" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Close all tabs",
    });
    await user.click(within(dialog).getByRole("button", { name: "Close all" }));

    const state = useWorkspaceStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.quires).toEqual({});
  });
});
