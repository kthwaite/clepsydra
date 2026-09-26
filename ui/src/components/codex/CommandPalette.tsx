import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatApiError, isInvalidSearchQuery } from "#/api/error";
import { useSearch, useTags } from "#/api/index";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { rankCommands } from "#/components/codex/commandRanking";
import {
  enabledStaticCommands,
  runtimeQuireCommands,
  type StaticCommandAction,
} from "#/components/codex/commandRegistry";
import { shortFolio } from "#/components/codex/folio-utils";
import { MobileGoTo } from "#/components/codex/MobileGoTo";
import { Tick } from "#/components/codex/Tick";
import { goToView } from "#/components/codex/viewRegistry";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";
import { useTheme } from "#/components/ThemeProvider";
import { Button } from "#/components/ui/button";
import { useDebounce } from "#/hooks/useDebounce";
import {
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayAiJournal } from "#/hooks/useOpenTodayAiJournal";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { formatChord, SHORTCUTS } from "#/lib/shortcuts";
import { deriveQuireName } from "#/store/quires";
import { useUiStore } from "#/store/ui";
import { selectActiveTab, useWorkspaceStore } from "#/store/workspace";

type Command = {
  /** Result group: Commands, Pages or Tags. */
  kind: "cmd" | "note" | "tag";
  /** Stable identity (command id, page path, tag). Never shown. */
  id: string;
  title: string;
  /** Right-hand meta: shortcut chord, short page code, or tag count. */
  hint?: string;
  /** Optional line beneath the title (a page's search snippet). */
  sub?: string;
  action: () => void;
};

const GROUP_LABEL: Record<Command["kind"], string> = {
  cmd: "Commands",
  note: "Pages",
  tag: "Tags",
};

export function CommandPalette() {
  const open = useUiStore((s) => s.isSearchOpen);
  if (!open) return null;
  return <CommandPaletteContent />;
}

function CommandPaletteContent() {
  const features = useFeatureFlags();
  const open = useUiStore((s) => s.isSearchOpen);
  const close = useUiStore((s) => s.closeSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openCaptureAside = useUiStore((s) => s.openCaptureAside);
  const openBookImport = useUiStore((s) => s.openBookImport);
  const openSettings = useUiStore((s) => s.openSettings);
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  const runBoot = useUiStore((s) => s.runBoot);
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const openTodayJournal = useOpenTodayJournal();
  const openTodayAiJournal = useOpenTodayAiJournal();
  const { toggle: toggleTheme } = useTheme();
  const mobile = useMobileLayout();

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Last pointer position that moved the highlight. Rows re-render under a
   * stationary pointer on every keystroke, and the browser then re-fires
   * mouse events at the same coordinates; those must not steal the highlight
   * from the best match. */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const onRowPointerMove = (
    e: ReactMouseEvent<HTMLButtonElement>,
    i: number,
  ) => {
    const last = lastPointerRef.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    setSel(i);
  };

  const debouncedQ = useDebounce(open ? q : "", 200);
  const {
    data: searchResults,
    error: searchError,
    isError: searchIsError,
    isFetching: searchIsFetching,
    refetch: retrySearch,
  } = useSearch(open && debouncedQ.length > 0 ? debouncedQ : "", 12);
  const { data: tags } = useTags(open);
  const searchIsCurrent = q === debouncedQ;
  const currentSearchResults = searchIsCurrent ? searchResults : undefined;
  const showSearchLoading =
    q.length > 0 && (!searchIsCurrent || searchIsFetching);
  const showSearchError = searchIsCurrent && searchIsError;
  const searchSyntaxError =
    showSearchError && isInvalidSearchQuery(searchError);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const verbCommands = useMemo<Command[]>(
    () =>
      enabledStaticCommands(features).map((command) => ({
        kind: "cmd",
        id: command.id,
        hint: command.shortcut
          ? formatChord(SHORTCUTS[command.shortcut].chord)
          : undefined,
        title: command.title,
        action: () => {
          const action: StaticCommandAction = command.action;
          switch (action) {
            case "navigate-atrium":
              goToView("atrium", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "open-today-journal":
              openTodayJournal();
              return;
            case "open-today-ai-journal":
              openTodayAiJournal();
              return;
            case "open-capture-aside":
              openCaptureAside();
              return;
            case "open-constellation":
              goToView("constellation", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "navigate-gazetteer":
              goToView("gazetteer", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "navigate-bases":
              goToView("bases", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "navigate-academic":
              goToView("academic", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "navigate-repairs":
              goToView("repairs", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "navigate-conflicts":
              goToView("conflicts", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "navigate-rubbish":
              goToView("rubbish", {
                navigate,
                openTab,
                activateTab,
                leaveWorkspace,
              });
              return;
            case "create-base":
              leaveWorkspace(() =>
                navigate({ to: "/bases", search: { create: true } }),
              );
              return;
            case "add-book":
              openBookImport();
              return;
            case "inscribe-folio":
              openInscribe();
              return;
            case "open-settings":
              openSettings("appearance");
              return;
            case "toggle-theme":
              toggleTheme();
              return;
            case "open-shortcut-help":
              openShortcutHelp();
              return;
            case "run-boot-sequence":
              runBoot();
              return;
            default:
              action satisfies never;
          }
        },
      })),
    [
      features,
      navigate,
      openTab,
      activateTab,
      leaveWorkspace,
      openTodayJournal,
      openTodayAiJournal,
      toggleTheme,
      openInscribe,
      openCaptureAside,
      openBookImport,
      openSettings,
      openShortcutHelp,
      runBoot,
    ],
  );

  const noteCommands = useMemo<Command[]>(() => {
    if (!currentSearchResults) return [];
    return currentSearchResults.map((r) => ({
      kind: "note" as const,
      id: r.path,
      hint: shortFolio(r.path),
      title: r.title || r.path,
      sub: r.snippet?.replace(/<\/?mark>/g, "") || r.path,
      action: () => openTab("page", r.path, r.title || r.path),
    }));
  }, [currentSearchResults, openTab]);

  const tagCommands = useMemo<Command[]>(() => {
    if (!tags) return [];
    return tags.slice(0, 12).map((t) => ({
      kind: "tag" as const,
      id: `tag.${t.tag}`,
      title: t.tag,
      hint: String(t.count ?? 0),
      action: () =>
        leaveWorkspace(() =>
          navigate({
            to: "/gazetteer",
            search: { tags: [t.tag] },
          }),
        ),
    }));
  }, [leaveWorkspace, navigate, tags]);

  const quireMap = useWorkspaceStore((s) => s.quires);
  const activeTab = useWorkspaceStore(selectActiveTab);

  const quireCommands = useMemo<Command[]>(() => {
    if (activeTab?.type !== "page") return [];

    return runtimeQuireCommands({
      activeQuireId: activeTab.quireId,
      quires: Object.values(quireMap),
    }).map((command) => ({
      kind: "cmd",
      id: command.id,
      title: command.title,
      action: () => {
        const store = useWorkspaceStore.getState();
        switch (command.action) {
          case "create-quire":
            store.createQuire(activeTab.id, deriveQuireName(activeTab.label));
            return;
          case "add-to-quire":
            store.addTabToQuire(activeTab.id, command.quireId);
            return;
          case "remove-from-quire":
            store.removeTabFromQuire(activeTab.id);
            return;
          default:
            command satisfies never;
        }
      },
    }));
  }, [activeTab, quireMap]);

  const filtered = useMemo<Command[]>(() => {
    if (!q) return [...verbCommands, ...tagCommands].slice(0, 10);
    const ql = q.toLowerCase();
    const verbsMatch = rankCommands([...verbCommands, ...quireCommands], q);
    const tagsMatch = rankCommands(
      tagCommands.filter((c) => c.title.toLowerCase().includes(ql)),
      q,
    );
    return [...verbsMatch, ...noteCommands, ...tagsMatch].slice(0, 14);
  }, [q, verbCommands, noteCommands, tagCommands, quireCommands]);

  // Rows are tall and the list scrolls without a visible bar, so keep the
  // keyboard selection in view as it moves.
  const listRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the selection or the result set changes
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-active]")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [sel, filtered]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[sel]?.action();
      close();
    }
  };

  return (
    <CodexModalShell
      ariaLabel="Command console"
      maxWidthClassName="max-w-[640px]"
      onDismiss={close}
      onKeyDown={onKey}
      panelClassName="flex flex-col rounded-[18px]"
      widthClassName="w-[92%]"
    >
      {mobile ? (
        <div className="flex items-center gap-2.5 px-4 pt-5">
          <label className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-ground px-4 shadow-[0_0_0_2px_var(--accent)]">
            <Search aria-hidden size={18} className="shrink-0 text-mute" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              placeholder="Search pages, tasks and screens"
              aria-label="Command query"
              className="min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-mute"
            />
          </label>
          <button
            type="button"
            onClick={close}
            className={cn(
              "min-h-11 rounded-md px-1 text-[15px] text-accent",
              FOCUS_RING_NATIVE,
            )}
          >
            Cancel
          </button>
        </div>
      ) : (
        <label className="flex h-[72px] items-center gap-3.5 px-[26px]">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            placeholder="Search pages · kind:recipe (tag:beer | tag:wine)"
            aria-label="Command query"
            className="flex-1 bg-transparent text-[21px] text-ink outline-none placeholder:text-faint"
          />
          <span className="text-[12.5px] text-mute">esc</span>
        </label>
      )}
      <div
        ref={listRef}
        className={cn(
          "cl-noscroll overflow-auto px-3.5 pb-4",
          mobile ? "min-h-0 flex-1 pt-3" : "max-h-[420px]",
        )}
      >
        {showSearchLoading && (
          <div
            role="status"
            aria-live="polite"
            className="px-3 py-6 text-center text-[13.5px] text-mute"
          >
            Searching…
          </div>
        )}
        {showSearchError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 px-3 py-4 text-[13.5px] text-hot"
          >
            <span>{formatApiError(searchError, "Search failed.")}</span>
            {!searchSyntaxError && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Retry search"
                onPress={() => void retrySearch()}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        {!showSearchLoading && !showSearchError && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-[13.5px] text-mute">
            No results
          </div>
        )}
        {filtered.map((c, i) => {
          const active = i === sel;
          const startsGroup = i === 0 || filtered[i - 1].kind !== c.kind;
          return (
            <Fragment key={`${c.kind}:${c.id}`}>
              {startsGroup && (
                <h3 className="flex items-center gap-2.5 px-3 pt-3.5 pb-1.5 font-serif text-[17px] italic text-mute">
                  <Tick />
                  {GROUP_LABEL[c.kind]}
                </h3>
              )}
              <button
                type="button"
                data-active={active || undefined}
                data-command-id={c.id}
                onMouseMove={(e) => onRowPointerMove(e, i)}
                onClick={() => {
                  c.action();
                  close();
                }}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer flex-col rounded-xl px-3 py-2.5 text-left",
                  active && "bg-accent-tint",
                )}
              >
                <span className="flex w-full min-w-0 items-baseline gap-3.5">
                  <span
                    className={cn(
                      "min-w-0 truncate text-ink",
                      c.kind === "note"
                        ? "font-serif text-[20px] leading-tight"
                        : "text-[15.5px]",
                    )}
                  >
                    {c.title}
                  </span>
                  <span className="flex-1" />
                  {c.hint && (
                    <span className="flex-shrink-0 text-[13px] text-mute">
                      {c.hint}
                    </span>
                  )}
                </span>
                {c.kind === "note" && c.sub && (
                  <span className="mt-0.5 w-full truncate text-[13.5px] text-mute">
                    {c.sub}
                  </span>
                )}
              </button>
            </Fragment>
          );
        })}
        {mobile && <MobileGoTo onGo={close} />}
      </div>
      {!mobile && (
        <div className="flex items-center gap-6 bg-ground px-[26px] pt-3.5 pb-[18px] text-[12.5px] text-mute">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="flex-1" />
          <span>
            {filtered.length} {filtered.length === 1 ? "result" : "results"}
          </span>
        </div>
      )}
    </CodexModalShell>
  );
}
