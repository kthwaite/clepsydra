import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "#/lib/cn";
import { QUIRE_COLORS, quireColorVar } from "#/store/quires";
import { useWorkspaceStore } from "#/store/workspace";

export type MenuTarget =
  | { kind: "tab"; tabId: string; x: number; y: number }
  | { kind: "quire"; quireId: string; x: number; y: number };

type SheafContextMenuProps = {
  target: MenuTarget;
  onClose: () => void;
};

const MENU_WIDTH = 220;

/** Hand-rolled context menu for SHEAF tabs and quire labels. RAC menus were
 * deferred for the tab strip (docs/design-notes/defer-tabbar-rac-migration.md);
 * this follows the CommandPalette's overlay + panel idiom instead. */
export function SheafContextMenu({ target, onClose }: SheafContextMenuProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const quires = useWorkspaceStore((s) => s.quires);
  // null = root menu; a string = a name being drafted (new quire / rename).
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const store = () => useWorkspaceStore.getState();
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const left = Math.max(
    4,
    Math.min(target.x, window.innerWidth - MENU_WIDTH - 8),
  );
  const top = Math.max(4, Math.min(target.y, window.innerHeight - 280));

  let content: React.ReactNode = null;

  if (target.kind === "tab") {
    const tab = tabs.find((t) => t.id === target.tabId);
    if (!tab) return null;
    content = (
      <>
        <Row
          label={tab.pinned ? "UNPIN" : "PIN"}
          onPick={act(() => store().togglePin(tab.id))}
        />
        {!tab.pinned && (
          <Row label="CLOSE" onPick={act(() => store().closeTab(tab.id))} />
        )}
        <Row
          label="CLOSE OTHERS"
          onPick={act(() => store().closeOtherTabs(tab.id))}
        />
        <Divider />
        {draft === null ? (
          <Row label="NEW QUIRE…" onPick={() => setDraft("")} />
        ) : (
          <NameInput
            value={draft}
            onChange={setDraft}
            onCommit={(name) => {
              store().createQuire(tab.id, name);
              onClose();
            }}
            onCancel={onClose}
          />
        )}
        {Object.values(quires)
          .filter((q) => q.id !== tab.quireId)
          .map((q) => (
            <Row
              key={q.id}
              label={`ADD TO ${q.name}`}
              swatch={quireColorVar(q.color)}
              onPick={act(() => store().addTabToQuire(tab.id, q.id))}
            />
          ))}
        {tab.quireId && (
          <Row
            label="REMOVE FROM QUIRE"
            onPick={act(() => store().removeTabFromQuire(tab.id))}
          />
        )}
      </>
    );
  } else {
    const quire = quires[target.quireId];
    if (!quire) return null;
    content = (
      <>
        {draft === null ? (
          <Row label="RENAME…" onPick={() => setDraft(quire.name)} />
        ) : (
          <NameInput
            value={draft}
            onChange={setDraft}
            onCommit={(name) => {
              store().renameQuire(quire.id, name);
              onClose();
            }}
            onCancel={onClose}
          />
        )}
        <div className="flex items-center gap-2 px-3 py-[5px]">
          {QUIRE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`recolor ${c}`}
              onClick={act(() => store().recolorQuire(quire.id, c))}
              className={cn(
                "h-[10px] w-[10px] cursor-pointer",
                quire.color === c && "outline outline-1 outline-ink",
              )}
              style={{ background: quireColorVar(c) }}
            />
          ))}
        </div>
        <Row
          label={quire.collapsed ? "EXPAND" : "COLLAPSE"}
          onPick={act(() => store().toggleQuireCollapse(quire.id))}
        />
        <Divider />
        <Row
          label="UNGROUP"
          onPick={act(() => store().ungroupQuire(quire.id))}
        />
        <Row
          label="CLOSE QUIRE"
          onPick={act(() => store().closeQuireTabs(quire.id))}
        />
      </>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60]"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        role="menu"
        aria-label="sheaf context menu"
        onMouseDown={(e) => e.stopPropagation()}
        className="cl-mono fixed flex w-[220px] flex-col border-[1.5px] border-ink bg-paper py-1 text-[10px] uppercase tracking-[0.08em] text-ink"
        style={{ left, top }}
      >
        {content}
      </div>
    </div>,
    document.body,
  );
}

function Row({
  label,
  onPick,
  swatch,
}: {
  label: string;
  onPick: () => void;
  swatch?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className="flex cursor-pointer items-center gap-2 px-3 py-[5px] text-left hover:bg-ink hover:text-paper"
    >
      {swatch && (
        <span
          className="inline-block h-[6px] w-[6px] flex-shrink-0"
          style={{ background: swatch }}
          aria-hidden
        />
      )}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-rule-soft" />;
}

function NameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="px-3 py-[5px]">
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") onCancel();
        }}
        placeholder="QUIRE NAME"
        className="w-full border border-ink/40 bg-transparent px-2 py-[3px] text-[10px] uppercase tracking-[0.08em] text-ink outline-none placeholder:text-ink-faint"
      />
    </div>
  );
}
