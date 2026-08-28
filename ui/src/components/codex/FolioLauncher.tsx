import { folioDisplayName, shortFolio } from "#/components/codex/folio-utils";
import { KindIcon } from "#/components/KindIcon";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayAiJournal } from "#/hooks/useOpenTodayAiJournal";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
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
        <div className="flex items-baseline justify-between border-b border-rule pb-1.5">
          <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            WORKSPACE / EMPTY
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
            NO FOLIO OPEN
          </span>
        </div>

        <div className="mt-4">
          <div className="cl-mono mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            Actions
          </div>
          <div className="flex flex-col">
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
        </div>

        <div className="mt-5">
          <div className="cl-mono mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            Recent · {recent.length}
          </div>
          {recent.length === 0 ? (
            <p className="cl-marg m-0">No recent folios.</p>
          ) : (
            <div className="flex flex-col">
              {recent.map((entry) => {
                const name = folioDisplayName(entry.path);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    aria-label={`Open ${name || entry.path}`}
                    onClick={() => openTab("page", entry.path, name)}
                    className="group flex items-center gap-2 border-b border-rule-soft py-1.5 text-left"
                  >
                    <KindIcon
                      kind={resolveKind({ path: entry.path })}
                      className="flex-shrink-0"
                    />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-ink-mute group-hover:text-ink">
                      {name}
                    </span>
                    <span className="cl-mono flex-shrink-0 text-[9px] text-ink-mute">
                      {shortFolio(entry.path)}
                    </span>
                    <span className="cl-mono flex-shrink-0 text-[9px] text-ink-mute">
                      {formatRelativeTime(
                        new Date(entry.openedAt).toISOString(),
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center justify-between border-b border-rule-soft py-1.5 text-left"
    >
      <span className="text-[12px] text-ink-mute group-hover:text-ink">
        {label}
      </span>
      <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
        {hint}
      </span>
    </button>
  );
}
