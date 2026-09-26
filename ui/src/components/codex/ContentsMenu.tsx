import { ChevronDown } from "lucide-react";
import {
  Autocomplete,
  Button,
  Dialog,
  DialogTrigger,
  Header,
  Input,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  SearchField,
  useFilter,
} from "react-aria-components";
import { ContentsBadge } from "#/components/codex/ContentsBadge";
import type { CodexView } from "#/components/codex/useCodexView";
import {
  contentsGroups,
  enabledNavItems,
  isCoreView,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";
import { cn } from "#/lib/cn";
import { formatChord, SHORTCUTS } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";
import { useViewHistory } from "#/store/viewHistory";

/** The header's Contents trigger and the sheet listing every other screen,
 *  grouped from VIEW_REGISTRY (spec §5.2). */
export function ContentsMenu({
  view,
  onGo,
  anchorRef,
}: {
  view: CodexView;
  onGo: (view: CodexView) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const features = useFeatureFlags();
  const isOpen = useUiStore((s) => s.isContentsOpen);
  const setOpen = useUiStore((s) => s.setContentsOpen);
  const recent = enabledNavItems(
    useViewHistory((s) => s.recent),
    features,
  );
  const { contains } = useFilter({ sensitivity: "base" });
  const active = !isCoreView(view) && VIEW_REGISTRY[view].navRoot !== "atrium";
  const groups = contentsGroups(features);

  const go = (target: CodexView) => {
    setOpen(false);
    onGo(target);
  };

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <Button
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex cursor-pointer items-center gap-1 rounded-full text-[14px] outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent data-[focus-visible]:ring-offset-4 data-[focus-visible]:ring-offset-ground",
          active ? "font-medium text-ink" : "text-mute hover:text-ink",
        )}
      >
        Contents
        <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        {active && (
          <span
            aria-hidden
            className="absolute -bottom-2.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent"
          />
        )}
      </Button>
      <Popover
        triggerRef={anchorRef}
        placement="bottom"
        offset={0}
        className="z-50 w-[calc(100vw-48px)] rounded-[22px] bg-raise shadow-lg outline-none"
      >
        <Dialog aria-label="Contents" className="p-8 outline-none">
          <Autocomplete filter={contains}>
            <div className="mb-6 flex items-center gap-6">
              <SearchField
                aria-label="Filter screens"
                autoFocus
                className="flex-1"
              >
                <Input
                  placeholder="Filter screens"
                  className="w-full rounded-full bg-sink px-4 py-2 text-[14px] text-ink outline-none placeholder:text-mute"
                />
              </SearchField>
              {recent.length > 0 && (
                <nav
                  aria-label="Recently"
                  className="flex items-center gap-2 text-[13px] text-mute"
                >
                  <span aria-hidden>Recently:</span>
                  {recent.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => go(v)}
                      className="cursor-pointer text-ink-2 hover:text-accent"
                    >
                      {VIEW_REGISTRY[v].label}
                    </button>
                  ))}
                </nav>
              )}
            </div>
            <ListBox
              aria-label="Screens"
              onAction={(key) => go(key as CodexView)}
              className="grid grid-cols-5 gap-8 outline-none"
            >
              {groups.map(({ group, views }) => (
                <ListBoxSection key={group} id={group} aria-label={group}>
                  <Header className="mb-3 font-serif text-[17px] italic text-mute">
                    {group}
                  </Header>
                  {views.map((v) => {
                    const d = VIEW_REGISTRY[v];
                    return (
                      <ListBoxItem
                        key={v}
                        id={v}
                        textValue={d.label}
                        data-view={v}
                        className={cn(
                          "mb-1 block cursor-pointer rounded-xl px-3 py-2 outline-none",
                          "data-[focused]:bg-sink data-[hovered]:bg-sink",
                          isCoreView(v) && "bg-accent-tint",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-[15px] font-medium text-ink">
                            {d.label}
                          </span>
                          <ContentsBadge view={v} />
                          <span className="flex-1" />
                          {d.shortcut && (
                            <span className="text-[12px] text-faint">
                              {formatChord(SHORTCUTS[d.shortcut].chord)}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-[12.5px] text-mute">
                          {d.description}
                        </span>
                      </ListBoxItem>
                    );
                  })}
                </ListBoxSection>
              ))}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
