import { folioDisplayName, shortFolio } from "#/components/codex/folio-utils";
import { Section } from "#/components/codex/Section";
import { KindIcon } from "#/components/KindIcon";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayAiJournal } from "#/hooks/useOpenTodayAiJournal";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { resolveKind } from "#/lib/kind";
import { formatRelativeTime } from "#/lib/time";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

const RECENT_LIMIT = 8;

/**
 * Rich empty state for the workspace when no tab is open: quick actions plus a
 * recent-files list derived entirely from existing stores (no data fetching).
 * Recent labels come from the filename slug via folioDisplayName, since
 * openHistory stores only paths.
 */
export function FolioLauncher() {
  const openTab = useOpenTab();
  const openTodayJournal = useOpenTodayJournal();
  const openTodayAiJournal = useOpenTodayAiJournal();
  const openSearch = useUiStore((s) => s.openSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const history = useWorkspaceStore((s) => s.openHistory);
  const recent = history.slice(0, RECENT_LIMIT);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-[520px]">
        <h1 className="m-0 font-serif text-[44px] leading-none text-ink">
          No page open
        </h1>

        <Section compact label="Actions" className="mt-10">
          <div className="flex flex-col gap-0.5">
            <LauncherAction
              label="Open console"
              hint="⌘K"
              onClick={openSearch}
            />
            <LauncherAction
              label="Inscribe new folio"
              hint="⌘N"
              onClick={openInscribe}
            />
            <LauncherAction
              label="Today's journal"
              hint="⌘D"
              onClick={openTodayJournal}
            />
            <LauncherAction
              label="AI journal"
              hint="—"
              onClick={openTodayAiJournal}
            />
            <LauncherAction
              label="Open Constellation"
              hint="⌘G"
              onClick={() => openTab("graph")}
            />
          </div>
        </Section>

        <Section
          compact
          pip="dim"
          label="Recent"
          caption={String(recent.length)}
          className="mt-10"
        >
          {recent.length === 0 ? (
            <p className="m-0 text-[13px] text-mute">No recent folios.</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {recent.map((entry) => {
                const name = folioDisplayName(entry.path);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    aria-label={`Open ${name || entry.path}`}
                    onClick={() => openTab("page", entry.path, name)}
                    className={cn(ROW_CLASS, "gap-2.5")}
                  >
                    <KindIcon
                      kind={resolveKind({ path: entry.path })}
                      className="flex-shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-ink-2 group-hover:text-ink">
                      {name}
                    </span>
                    <span className="flex-shrink-0 text-[12.5px] text-faint">
                      {shortFolio(entry.path)}
                    </span>
                    <span className="flex-shrink-0 text-[12.5px] tabular-nums text-mute">
                      {formatRelativeTime(
                        new Date(entry.openedAt).toISOString(),
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

const ROW_CLASS = cn(
  "group flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left text-[14px] transition-colors hover:bg-sink",
  FOCUS_RING_NATIVE,
);

function LauncherAction({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={ROW_CLASS}>
      <span className="text-ink-2 group-hover:text-ink">{label}</span>
      <span className="text-[12.5px] text-faint">{hint}</span>
    </button>
  );
}
