import { X } from "lucide-react";
import type { CSSProperties } from "react";
import { KindIcon } from "#/components/KindIcon";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { BottomSheet } from "#/components/ui/sheet";
import { useActivateTabWithFolioHistory } from "#/hooks/useFolioHistoryNavigation";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { resolveKindFromPath } from "#/lib/kind";
import { quireColorVar, sheafRuns, sheafSegments } from "#/store/quires";
import { useUiStore } from "#/store/ui";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

interface OpenPagesSheetProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

/** Mobile open pages (spec §9 Q3): the Sheaf's groups as a bottom sheet.
 *  Collapsed quires still list their pages; collapse saves desktop space. */
export function OpenPagesSheet({ isOpen, onOpenChange }: OpenPagesSheetProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const quires = useWorkspaceStore((s) => s.quires);
  const closeAllTabs = useWorkspaceStore((s) => s.closeAllTabs);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const pageTabs = tabs.filter((tab) => tab.type === "page");
  const runs = sheafRuns(sheafSegments(pageTabs, quires)).filter((run) =>
    run.kind === "quire" ? run.members.length > 0 : run.tabs.length > 0,
  );
  const close = () => onOpenChange(false);

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      aria-label="Open pages"
    >
      <div className="flex flex-col gap-[18px]">
        <div className="flex items-baseline gap-2.5">
          <h2 className="flex-1 font-serif text-[30px] leading-none">
            Open pages
          </h2>
          {pageTabs.length > 0 && (
            <Button variant="ghost" size="sm" onPress={closeAllTabs}>
              Close all
            </Button>
          )}
        </div>
        {pageTabs.length === 0 && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[15px] text-mute">No open pages.</p>
            <Button
              variant="secondary"
              onPress={() => {
                openInscribe();
                close();
              }}
            >
              New page
            </Button>
          </div>
        )}
        {runs.map((run) =>
          run.kind === "quire" ? (
            <PageGroup
              key={run.quire.id}
              name={run.quire.name}
              color={quireColorVar(run.quire.color)}
              tabs={run.members}
              onPicked={close}
            />
          ) : (
            <PageGroup
              key={`loose:${run.tabs[0]?.id}`}
              name="Ungrouped"
              tabs={run.tabs}
              onPicked={close}
            />
          ),
        )}
      </div>
    </BottomSheet>
  );
}

function PageGroup({
  name,
  color,
  tabs,
  onPicked,
}: {
  name: string;
  /** Quire hue; absent for loose pages. */
  color?: string;
  tabs: TabDescriptor[];
  onPicked: () => void;
}) {
  const rule = color
    ? "shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--q)_45%,transparent)]"
    : "shadow-[inset_0_-1px_0_var(--rule)]";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a list of page rows, not form controls; a fieldset would add form semantics, so an ARIA group names the quire.
    <div
      aria-label={name}
      role="group"
      className="flex flex-col gap-0.5"
      style={color ? ({ "--q": color } as CSSProperties) : undefined}
    >
      <div
        className={cn(
          "mb-1.5 flex items-center gap-2 pb-1.5 font-serif text-[18px] italic",
          color ? "text-[var(--q)]" : "text-mute",
          rule,
        )}
      >
        {color && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-[var(--q)]"
          />
        )}
        {name}
      </div>
      {tabs.map((tab) => (
        <PageRow key={tab.id} tab={tab} onPicked={onPicked} />
      ))}
    </div>
  );
}

function PageRow({
  tab,
  onPicked,
}: {
  tab: TabDescriptor;
  onPicked: () => void;
}) {
  const active = useWorkspaceStore((s) => s.activeTabId === tab.id);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const activate = useActivateTabWithFolioHistory();
  return (
    <div
      className={cn(
        "flex h-[52px] items-center gap-3 rounded-xl pr-1.5 pl-3",
        active && "bg-accent-tint",
      )}
    >
      <KindIcon
        kind={resolveKindFromPath(tab.path ?? "")}
        tone="mono"
        size={16}
        className={active ? "text-accent" : "text-mute"}
      />
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => {
          activate(tab.id);
          onPicked();
        }}
        className={cn(
          "min-h-11 min-w-0 flex-1 truncate rounded-md text-left text-[15.5px] text-ink",
          active && "font-medium",
          FOCUS_RING_NATIVE,
        )}
      >
        {tab.label}
      </button>
      <IconButton
        aria-label={`Close ${tab.label}`}
        onPress={() => closeTab(tab.id)}
        className="h-11 w-11 text-faint"
      >
        <X />
      </IconButton>
    </div>
  );
}
