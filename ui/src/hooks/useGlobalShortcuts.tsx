import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useTheme } from "#/components/ThemeProvider";
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

const inWorkspace = () => window.location.pathname.startsWith("/workspace");
const inTasking = () => window.location.pathname.startsWith("/tasking");

function cycleTab(dir: 1 | -1) {
  const { tabs, quires, activeTabId, activateTab } =
    useWorkspaceStore.getState();
  const target = cycleTargetId(tabs, quires, activeTabId, dir === -1);
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
  const toggleSearch = useUiStore((s) => s.toggleSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openCaptureAside = useUiStore((s) => s.openCaptureAside);
  const openSettings = useUiStore((s) => s.openSettings);
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  const { toggle: toggleTheme } = useTheme();
  const openTab = useOpenTab();
  const openTodayJournal = useOpenTodayJournal();

  // Exhaustive over GlobalShortcutId: adding a `scope: "global"` registry
  // entry without a binding here is a compile error.
  const bindings = useMemo<Record<GlobalShortcutId, Binding>>(
    () => ({
      "palette.toggle": { run: toggleSearch },
      "nav.atrium": { run: () => navigate({ to: "/" }) },
      "journal.today": { run: openTodayJournal },
      "nav.constellation": { run: () => openTab("graph") },
      "nav.gazetteer": {
        run: () =>
          navigate({ to: "/gazetteer", search: { sort: "ts", page: 1 } }),
      },
      "nav.tasking": { run: () => navigate({ to: "/tasking" }) },
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
      "tabs.next": { when: inWorkspace, run: () => cycleTab(1) },
      "tabs.prev": { when: inWorkspace, run: () => cycleTab(-1) },
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
    }),
    [
      navigate,
      toggleSearch,
      openInscribe,
      openCaptureAside,
      openSettings,
      openShortcutHelp,
      toggleTheme,
      openTab,
      openTodayJournal,
    ],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // A modal or popover dialog owns keyboard input while it's open — no
      // global shortcut should fire underneath it.
      if (document.querySelector('[role="dialog"]')) return;
      for (const id of GLOBAL_SHORTCUT_IDS) {
        if (!matchesChord(e, SHORTCUTS[id].chord)) continue;
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
