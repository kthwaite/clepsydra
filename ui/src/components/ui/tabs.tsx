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
import { cn } from "#/components/ui/utils";

export function Tabs({ className, ...props }: RACTabsProps) {
  return <RACTabs {...props} className={cn("flex flex-col", className)} />;
}

export function TabList<T extends object>({
  className,
  ...props
}: RACTabListProps<T>) {
  return <RACTabList {...props} className={cn("flex gap-4", className)} />;
}

export function Tab({ className, ...props }: RACTabProps) {
  return (
    <RACTab
      {...props}
      className={composeRenderProps(className, (prev) =>
        cn(
          "cursor-default pb-1 text-xs uppercase tracking-wider outline-none transition-colors",
          "text-muted-foreground data-[hovered]:text-foreground",
          "data-[selected]:border-b-2 data-[selected]:border-foreground data-[selected]:font-bold data-[selected]:text-foreground",
          "data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring data-[focus-visible]:outline-offset-2",
          prev,
        ),
      )}
    />
  );
}

export function TabPanel({ className, ...props }: RACTabPanelProps) {
  return <RACTabPanel {...props} className={cn("outline-none", className)} />;
}
