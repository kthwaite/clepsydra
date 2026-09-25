import {
  composeRenderProps,
  Tab as RACTab,
  TabList as RACTabList,
  type TabListProps as RACTabListProps,
  TabPanel as RACTabPanel,
  type TabPanelProps as RACTabPanelProps,
  type TabProps as RACTabProps,
  Tabs as RACTabs,
  type TabsProps as RACTabsProps,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export function Tabs({ className, ...props }: RACTabsProps) {
  return <RACTabs {...props} className={cn("flex flex-col", className)} />;
}

export function TabList<T extends object>({
  className,
  ...props
}: RACTabListProps<T>) {
  return <RACTabList {...props} className={cn("flex gap-5", className)} />;
}

export function Tab({ className, ...props }: RACTabProps) {
  return (
    <RACTab
      {...props}
      className={composeRenderProps(className, (prev) =>
        cn(
          "cursor-default rounded-sm pb-1.5 text-[14px] transition-colors",
          "text-mute data-[hovered]:text-ink",
          "data-[selected]:font-medium data-[selected]:text-ink data-[selected]:underline data-[selected]:decoration-accent data-[selected]:decoration-[1.5px] data-[selected]:underline-offset-[7px]",
          FOCUS_RING,
          prev,
        ),
      )}
    />
  );
}

export function TabPanel({ className, ...props }: RACTabPanelProps) {
  return <RACTabPanel {...props} className={cn("outline-none", className)} />;
}
