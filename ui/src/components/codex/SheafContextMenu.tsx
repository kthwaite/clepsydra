import {
  type DOMAttributes,
  type FormEvent,
  type JSX,
  type ReactElement,
  useId,
  useState,
} from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import {
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuSeparator,
  SubmenuTrigger,
} from "#/components/ui/menu";
import { TextField } from "#/components/ui/text-field";
import { QUIRE_COLORS, quireColorVar } from "#/store/quires";
import { useWorkspaceStore } from "#/store/workspace";

export type MenuTarget =
  | { kind: "tab"; tabId: string }
  | { kind: "quire"; quireId: string };

export interface SheafContextMenuProps {
  target: MenuTarget;
  children: ReactElement<DOMAttributes<HTMLElement>, string>;
}

type NamingAction =
  | { kind: "create"; tabId: string; draft: string }
  | { kind: "rename"; quireId: string; draft: string }
  | null;

export function SheafContextMenu({
  target,
  children,
}: SheafContextMenuProps): JSX.Element {
  const tabs = useWorkspaceStore((state) => state.tabs);
  const quires = useWorkspaceStore((state) => state.quires);
  const [namingAction, setNamingAction] = useState<NamingAction>(null);
  const namingFormId = useId();

  const tab =
    target.kind === "tab"
      ? tabs.find((candidate) => candidate.id === target.tabId)
      : undefined;
  const quire = target.kind === "quire" ? quires[target.quireId] : undefined;

  const handleRootAction = (key: React.Key) => {
    const state = useWorkspaceStore.getState();

    if (target.kind === "tab") {
      const currentTab = state.tabs.find(
        (candidate) => candidate.id === target.tabId,
      );
      if (!currentTab) return;

      switch (key) {
        case "close":
          state.closeTab(target.tabId);
          break;
        case "close-others":
          state.closeOtherTabs(target.tabId);
          break;
        case "new-quire":
          setNamingAction({ kind: "create", tabId: target.tabId, draft: "" });
          break;
        case "remove-from-quire":
          state.removeTabFromQuire(target.tabId);
          break;
      }
      return;
    }

    const currentQuire = state.quires[target.quireId];
    if (!currentQuire) return;

    switch (key) {
      case "rename":
        setNamingAction({
          kind: "rename",
          quireId: target.quireId,
          draft: currentQuire.name,
        });
        break;
      case "toggle-collapse":
        state.toggleQuireCollapse(target.quireId);
        break;
      case "ungroup":
        state.ungroupQuire(target.quireId);
        break;
      case "close-quire":
        state.closeQuireTabs(target.quireId);
        break;
    }
  };

  const handleAddToQuire = (key: React.Key) => {
    const state = useWorkspaceStore.getState();
    if (target.kind !== "tab" || typeof key !== "string") return;

    const currentTab = state.tabs.find(
      (candidate) => candidate.id === target.tabId,
    );
    if (!currentTab || !state.quires[key]) return;

    state.addTabToQuire(target.tabId, key);
  };

  const handleColorAction = (key: React.Key) => {
    const state = useWorkspaceStore.getState();
    if (target.kind !== "quire" || !state.quires[target.quireId]) return;

    const color = QUIRE_COLORS.find((candidate) => candidate === key);
    if (!color) return;

    state.recolorQuire(target.quireId, color);
  };

  const updateNamingDraft = (draft: string) => {
    setNamingAction((current) => (current ? { ...current, draft } : null));
  };

  const commitNamingAction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!namingAction) return;

    const name = namingAction.draft.trim();
    if (!name) return;

    const state = useWorkspaceStore.getState();
    if (namingAction.kind === "create") {
      if (
        state.tabs.some((candidate) => candidate.id === namingAction.tabId)
      ) {
        state.createQuire(namingAction.tabId, name);
      }
    } else if (state.quires[namingAction.quireId]) {
      state.renameQuire(namingAction.quireId, name);
    }

    setNamingAction(null);
  };

  const otherQuires = tab
    ? Object.values(quires).filter((candidate) => candidate.id !== tab.quireId)
    : [];

  let menu: JSX.Element | null = null;
  if (tab) {
    menu = (
      <ContextMenuTrigger>
        {children}
        <Menu
          className="w-[220px]"
          aria-label="sheaf context menu"
          onAction={handleRootAction}
        >
          <MenuItem id="close">CLOSE</MenuItem>
          <MenuItem id="close-others">CLOSE OTHERS</MenuItem>
          <MenuSeparator />
          <MenuItem id="new-quire">NEW QUIRE…</MenuItem>
          {otherQuires.length > 0 && (
            <SubmenuTrigger>
              <MenuItem id="add-to-quire">ADD TO QUIRE</MenuItem>
              <Menu aria-label="Add to quire" onAction={handleAddToQuire}>
                {otherQuires.map((candidate) => (
                  <MenuItem
                    key={candidate.id}
                    id={candidate.id}
                    swatch={quireColorVar(candidate.color)}
                  >
                    {candidate.name.toUpperCase()}
                  </MenuItem>
                ))}
              </Menu>
            </SubmenuTrigger>
          )}
          {tab.quireId && (
            <MenuItem id="remove-from-quire">REMOVE FROM QUIRE</MenuItem>
          )}
        </Menu>
      </ContextMenuTrigger>
    );
  } else if (quire) {
    menu = (
      <ContextMenuTrigger>
        {children}
        <Menu
          className="w-[220px]"
          aria-label="sheaf context menu"
          onAction={handleRootAction}
        >
          <MenuItem id="rename">RENAME…</MenuItem>
          <SubmenuTrigger>
            <MenuItem id="color">COLOR</MenuItem>
            <Menu
              aria-label="Color"
              selectionMode="single"
              selectedKeys={new Set([quire.color])}
              onAction={handleColorAction}
            >
              {QUIRE_COLORS.map((color) => (
                <MenuItem
                  key={color}
                  id={color}
                  swatch={quireColorVar(color)}
                >
                  {color.toUpperCase()}
                </MenuItem>
              ))}
            </Menu>
          </SubmenuTrigger>
          <MenuItem id="toggle-collapse">
            {quire.collapsed ? "EXPAND" : "COLLAPSE"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem id="ungroup">UNGROUP</MenuItem>
          <MenuItem id="close-quire" variant="destructive">
            CLOSE QUIRE
          </MenuItem>
        </Menu>
      </ContextMenuTrigger>
    );
  }

  return (
    <>
      {menu ?? children}
      {namingAction && (
        <Dialog
          isOpen
          onOpenChange={(isOpen) => {
            if (!isOpen) setNamingAction(null);
          }}
          title={
            namingAction.kind === "create" ? "New quire" : "Rename quire"
          }
          size="sm"
          footer={
            <>
              <Button
                type="button"
                onPress={() => setNamingAction(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form={namingFormId}
                variant="primary"
                isDisabled={!namingAction.draft.trim()}
              >
                {namingAction.kind === "create" ? "Create" : "Rename"}
              </Button>
            </>
          }
        >
          <form id={namingFormId} onSubmit={commitNamingAction}>
            <TextField
              label="Quire name"
              value={namingAction.draft}
              onChange={updateNamingDraft}
              autoFocus
            />
          </form>
        </Dialog>
      )}
    </>
  );
}
