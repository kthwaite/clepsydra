import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { routeViewFromMatches } from "#/components/codex/useCodexView";
import { goToView } from "#/components/codex/viewRegistry";
import { useTheme } from "#/components/ThemeProvider";
import {
  type ActivateTabWithFolioHistory,
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import {
  type Chord,
  GLOBAL_SHORTCUT_IDS,
  type GlobalShortcutId,
  matchesChord,
  SHORTCUTS,
} from "#/lib/shortcuts";
import { useBoardStore } from "#/store/board";
import { cycleTargetId } from "#/store/quires";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

/** Bare-key chords (no mod/ctrl/alt) must not fire while the user is typing
 *  — buttons and other non-form elements are not "editable" and stay live. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t.isContentEditable
  );
}

type Binding = {
  run: () => void;
  /** Gate for route-scoped bindings; a matched-but-gated chord falls through
   *  to later bindings, or to the browser (no preventDefault), preserving
   *  pre-registry behaviour. */
  when?: () => boolean;
};

/** Shortcuts exempted from the open-dialog guard: a dialog's own controlling
 *  toggle must keep working while it's open (⌘K must still close the command
 *  palette it just opened), even though every other global shortcut stays
 *  suppressed underneath a dialog. */
const DIALOG_EXEMPT_IDS: ReadonlySet<GlobalShortcutId> = new Set([
  "palette.toggle",
]);

function cycleTab(dir: 1 | -1, activateTab: ActivateTabWithFolioHistory) {
  const { tabs, quires, activeTabId } = useWorkspaceStore.getState();
  const pageTabs = tabs.filter((tab) => tab.type === "page");
  const target = cycleTargetId(pageTabs, quires, activeTabId, dir === -1);
  if (target) activateTab(target);
}

/**
 * The app's single global keydown dispatcher. Mounted once (via
 * <GlobalShortcuts /> in __root.tsx). Skips events something else already
 * handled (e.defaultPrevented) — that one rule is the whole conflict policy:
 * inside the editor ⌘D/⌘I/⌘, mean marks; everywhere else they navigate.
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const router = useRouter();
  const toggleSearch = useUiStore((s) => s.toggleSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openCaptureAside = useUiStore((s) => s.openCaptureAside);
  const openSettings = useUiStore((s) => s.openSettings);
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  const { toggle: toggleTheme } = useTheme();
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const openTodayJournal = useOpenTodayJournal();

  // Exhaustive over GlobalShortcutId: adding a `scope: "global"` registry
  // entry without a binding here is a compile error.
  const bindings = useMemo<Record<GlobalShortcutId, Binding>>(() => {
    const inWorkspace = () =>
      routeViewFromMatches(router.state.matches) === "workspace";
    const inTasking = () =>
      routeViewFromMatches(router.state.matches) === "tasking";
    return {
      "palette.toggle": { run: toggleSearch },
      "nav.atrium": {
        run: () =>
          goToView("atrium", {
            navigate,
            openTab,
            activateTab,
            leaveWorkspace,
          }),
      },
      "journal.today": { run: openTodayJournal },
      "nav.constellation": {
        run: () =>
          goToView("constellation", {
            navigate,
            openTab,
            activateTab,
            leaveWorkspace,
          }),
      },
      "nav.gazetteer": {
        run: () =>
          goToView("gazetteer", {
            navigate,
            openTab,
            activateTab,
            leaveWorkspace,
          }),
      },
      "nav.tasking": {
        run: () =>
          goToView("tasking", {
            navigate,
            openTab,
            activateTab,
            leaveWorkspace,
          }),
      },
      "app.inscribe": { run: openInscribe },
      "journal.capture": { run: openCaptureAside },
      "app.settings": { run: () => openSettings("appearance") },
      "app.themeToggle": { run: toggleTheme },
      "app.shortcutHelp": { run: openShortcutHelp },
      "tabs.close": {
        when: inWorkspace,
        run: () => {
          const { activeTabId, closeTab } = useWorkspaceStore.getState();
          if (activeTabId) closeTab(activeTabId);
        },
      },
      "tabs.next": {
        when: inWorkspace,
        run: () => cycleTab(1, activateTab),
      },
      "tabs.prev": {
        when: inWorkspace,
        run: () => cycleTab(-1, activateTab),
      },
      // Tasking bindings read/write the board store via getState(), so they
      // need no reactive dependency in this memo.
      "tasking.newTask": {
        when: inTasking,
        run: () => useBoardStore.getState().openTaskModal({}),
      },
      "tasking.modeCard": {
        when: inTasking,
        run: () => useBoardStore.getState().setMode("card"),
      },
      "tasking.modeBacklog": {
        when: inTasking,
        run: () => useBoardStore.getState().setMode("backlog"),
      },
      "tasking.modeCycle": {
        when: inTasking,
        run: () => useBoardStore.getState().setMode("cycle"),
      },
      "tasking.modeTimeline": {
        when: inTasking,
        run: () => useBoardStore.getState().setMode("timeline"),
      },
      "tasking.focusFilter": {
        when: inTasking,
        run: () => document.getElementById("tasking-filter")?.focus(),
      },
      "tasking.toggleRail": {
        when: inTasking,
        run: () => {
          const s = useBoardStore.getState();
          s.setRailOpen(!s.railOpen);
        },
      },
    };
  }, [
    navigate,
    router,
    toggleSearch,
    openInscribe,
    openCaptureAside,
    openSettings,
    openShortcutHelp,
    toggleTheme,
    openTab,
    activateTab,
    leaveWorkspace,
    openTodayJournal,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // A modal or popover dialog owns keyboard input while it's open — no
      // global shortcut should fire underneath it, except a dialog's own
      // controlling toggle (DIALOG_EXEMPT_IDS), which must keep working so
      // e.g. ⌘K can still close the command palette it opened.
      const dialogOpen = document.querySelector('[role="dialog"]') !== null;
      for (const id of GLOBAL_SHORTCUT_IDS) {
        if (!matchesChord(e, SHORTCUTS[id].chord)) continue;
        if (dialogOpen && !DIALOG_EXEMPT_IDS.has(id)) continue;
        const chord: Chord = SHORTCUTS[id].chord;
        const bareKey = !chord.mod && !chord.ctrl && !chord.alt;
        if (bareKey && isEditableTarget(e.target)) continue;
        const binding = bindings[id];
        if (binding.when && !binding.when()) continue;
        e.preventDefault();
        binding.run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings]);
}

/** Render-nothing mount point for the dispatcher. */
export function GlobalShortcuts() {
  useGlobalShortcuts();
  return null;
}
