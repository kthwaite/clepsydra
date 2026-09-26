import { AlignLeft, ChevronLeft } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import { IconButton } from "#/components/ui/icon-button";
import { BottomSheet } from "#/components/ui/sheet";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";
import { useMobileChrome } from "#/store/mobileChrome";

export interface MobileFolioLayoutProps {
  header: ReactNode;
  document: ReactNode;
  details: ReactNode;
  relationships: ReactNode;
  contents: ReactNode;
  onBack: () => void;
  /** The page's quire; null for a loose page. */
  group: { name: string; color: string } | null;
  /** Save state for the page bar. */
  status: ReactNode;
  /** Pages linking here, for the Linked tab label. */
  linkedCount: number;
}

/** Touch targets for controls rendered inside the page and the sheet. */
const TOUCH =
  "[&_button]:min-h-11 [&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [&_select]:min-h-11";

const SEGMENT =
  "flex h-[34px] items-center justify-center rounded-full pb-0 text-[14px] data-[selected]:bg-raise data-[selected]:no-underline data-[selected]:shadow-[0_1px_2px_rgb(14_26_58/0.08)]";

/** Folio on a phone (spec §9 Q3): a reading bar, the page, a progress
 *  line, and a details sheet with Outline, Properties and Linked. */
export function MobileFolioLayout({
  header,
  document,
  details,
  relationships,
  contents,
  onBack,
  group,
  status,
  linkedCount,
}: MobileFolioLayoutProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const setOwnBar = useMobileChrome((s) => s.setOwnBar);
  // The frame hides its bar only while this page bar is on screen.
  useEffect(() => {
    setOwnBar(true);
    return () => setOwnBar(false);
  }, [setOwnBar]);
  const { progress } = useReadingProgress();
  const read = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col bg-ground ${TOUCH}`}>
      <nav
        aria-label="Page controls"
        className="cl-mobile-top flex h-14 shrink-0 items-center gap-1 pr-2.5 pl-2"
      >
        <IconButton aria-label="Back" onPress={onBack} className="h-11 w-11">
          <ChevronLeft />
        </IconButton>
        {group && (
          <span
            className="flex min-w-0 items-center gap-1.5 font-serif text-[16px] italic"
            style={{ color: group.color }}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
            />
            <span className="truncate">{group.name}</span>
          </span>
        )}
        <span className="min-w-0 flex-1" />
        <span className="min-w-0 shrink">{status}</span>
        <IconButton
          aria-label="Page details"
          aria-haspopup="dialog"
          onPress={() => setDetailsOpen(true)}
          className="h-11 w-11"
        >
          <AlignLeft />
        </IconButton>
      </nav>

      <main
        aria-label="Page document"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <div className="shrink-0 px-6 pt-4">{header}</div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{document}</div>
      </main>

      <div
        aria-hidden
        data-testid="reading-progress"
        className="mx-6 mb-2.5 h-[3px] shrink-0 overflow-hidden rounded-full bg-rule"
      >
        <span
          className="block h-full bg-accent"
          style={{ width: `${read}%` }}
        />
      </div>

      <BottomSheet
        isOpen={detailsOpen}
        onOpenChange={setDetailsOpen}
        aria-label="Page details"
        className={`${TOUCH} [&_[role=option]]:min-h-11`}
      >
        <Tabs defaultSelectedKey="outline">
          <TabList
            aria-label="Details"
            className="grid grid-cols-3 gap-0.5 rounded-full bg-sink p-[3px]"
          >
            <Tab id="outline" className={SEGMENT}>
              Outline
            </Tab>
            <Tab id="properties" className={SEGMENT}>
              Properties
            </Tab>
            <Tab id="linked" className={SEGMENT}>
              {`Linked · ${linkedCount}`}
            </Tab>
          </TabList>
          <TabPanel id="outline" className="pt-5">
            {/* An outline row jumps to its heading; the sheet must not keep
                covering it. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates clicks of the outline's own buttons */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation of those buttons fires click too */}
            <div
              onClick={(e) => {
                if ((e.target as Element).closest("button"))
                  setDetailsOpen(false);
              }}
            >
              {contents}
            </div>
          </TabPanel>
          <TabPanel id="properties" className="pt-5">
            {details}
          </TabPanel>
          <TabPanel id="linked" className="pt-5">
            {relationships}
          </TabPanel>
        </Tabs>
      </BottomSheet>
    </div>
  );
}
