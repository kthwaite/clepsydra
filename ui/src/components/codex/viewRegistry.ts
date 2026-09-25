import type { useNavigate } from "@tanstack/react-router";
import type { FeatureFlags, FeatureName } from "#/api/features";
import type { CodexView } from "#/components/codex/useCodexView";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";
import type {
  ActivateTabWithFolioHistory,
  LeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import type { ShortcutId } from "#/lib/shortcuts";
import {
  type OpenTabTarget,
  type TabType,
  useWorkspaceStore,
} from "#/store/workspace";

export interface ViewNavDeps {
  navigate: ReturnType<typeof useNavigate>;
  /** useOpenTab's opener: opens the tab, stamps folioOriginTabId, and
   * navigates to /workspace inside a workspace transition. */
  openTab: (
    type: TabType,
    path?: string,
    label?: string,
    target?: OpenTabTarget,
  ) => void;
  activateTab: ActivateTabWithFolioHistory;
  leaveWorkspace: LeaveFolioWorkspace;
}

export type ContentsGroup =
  | "Write"
  | "Organise"
  | "Gather"
  | "Maintain"
  | "Reference";

export const CONTENTS_GROUPS: readonly ContentsGroup[] = [
  "Write",
  "Organise",
  "Gather",
  "Maintain",
  "Reference",
];

interface ViewDescriptor {
  /** Header/Contents text and screen name. */
  label: string;
  /** Contents sheet group; null = not listed (home, transient states). */
  group: ContentsGroup | null;
  /** One line under the name in Contents. */
  description: string;
  /** Registered shortcut shown as a hint in Contents. */
  shortcut: ShortcutId | null;
  showsSheaf: boolean;
  feature: FeatureName | null;
  /** Route owns the entire content window; suppress both responsive shells. */
  fullPage?: boolean;
  /** Which rail/mobile entry highlights while this view is current; null =
   * no highlight (repairs, agenda). */
  navRoot: CodexView | null;
  /** Mobile bottom-bar presentation, for views listed in MOBILE_NAV. */
  mobile: { name: string; label: string } | null;
  /** Navigate to this view; null for states that are not direct targets. */
  go: ((deps: ViewNavDeps) => void) | null;
}

export const VIEW_REGISTRY: Record<CodexView, ViewDescriptor> = {
  atrium: {
    label: "Atrium",
    group: null,
    description: "Today at a glance.",
    shortcut: "nav.atrium",
    showsSheaf: false,
    feature: null,
    navRoot: "atrium",
    mobile: { name: "Atrium", label: "ATR" },
    go: ({ navigate }) => void navigate({ to: "/" }),
  },
  folio: {
    label: "Folio",
    group: "Write",
    description: "Pages, notes and journals, open as tabs.",
    shortcut: null,
    showsSheaf: true,
    feature: null,
    navRoot: "folio",
    mobile: null,
    go: ({ activateTab, leaveWorkspace, navigate }) => {
      const store = useWorkspaceStore.getState();
      const firstPage = store.tabs.find((tab) => tab.type === "page");
      if (firstPage) {
        activateTab(firstPage.id);
        return;
      }
      leaveWorkspace(() => {
        store.clearActiveTab();
        void navigate({ to: "/workspace" });
      });
    },
  },
  launcher: {
    label: "Launcher",
    group: null,
    description: "Open a page to start.",
    shortcut: null,
    showsSheaf: true,
    feature: null,
    navRoot: "folio",
    mobile: null,
    go: null,
  },
  constellation: {
    label: "Constellation",
    group: "Organise",
    description: "The link graph.",
    shortcut: "nav.constellation",
    showsSheaf: false,
    feature: null,
    navRoot: "constellation",
    mobile: { name: "Constellation", label: "GRAPH" },
    go: ({ openTab }) => openTab("graph"),
  },
  gazetteer: {
    label: "Gazetteer",
    group: "Organise",
    description: "Every page, filtered and sorted.",
    shortcut: "nav.gazetteer",
    showsSheaf: true,
    feature: null,
    navRoot: "gazetteer",
    mobile: { name: "Gazetteer", label: "GAZ" },
    go: ({ navigate }) => void navigate({ to: "/gazetteer" }),
  },
  stats: {
    label: "Stats",
    group: "Maintain",
    description: "Activity over time.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    navRoot: "stats",
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/stats" }),
  },
  tasking: {
    label: "Tasking",
    group: "Organise",
    description: "Board, backlog, cycles and timeline.",
    shortcut: "nav.tasking",
    showsSheaf: false,
    feature: null,
    navRoot: "tasking",
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/tasking" }),
  },
  academic: {
    label: "Academic",
    group: "Gather",
    description: "DOI, ISBN and Zotero imports.",
    shortcut: null,
    showsSheaf: false,
    feature: "academic",
    navRoot: "academic",
    mobile: { name: "Academic", label: "ACAD" },
    go: ({ navigate }) => void navigate({ to: "/academic" }),
  },
  bases: {
    label: "Bases",
    group: "Organise",
    description: "Saved queries as tables and boards.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    navRoot: "bases",
    mobile: { name: "Bases", label: "BASE" },
    go: ({ navigate }) => void navigate({ to: "/bases" }),
  },
  feeds: {
    label: "Feeds",
    group: "Gather",
    description: "Subscriptions and the river.",
    shortcut: null,
    showsSheaf: false,
    feature: "feeds",
    navRoot: "feeds",
    mobile: { name: "Feeds", label: "FEED" },
    go: ({ navigate }) => void navigate({ to: "/feeds" }),
  },
  docs: {
    label: "Docs",
    group: "Reference",
    description: "How Clepsydra works.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    navRoot: "docs",
    mobile: null,
    go: ({ navigate }) =>
      void navigate({ to: "/docs/$slug", params: { slug: DEFAULT_DOC_SLUG } }),
  },
  archive: {
    label: "Archive",
    group: null,
    description: "Web pages captured whole.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    fullPage: true,
    navRoot: null,
    mobile: null,
    go: null,
  },
  rubbish: {
    label: "Rubbish",
    group: "Maintain",
    description: "Binned pages, restorable.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    navRoot: "rubbish",
    mobile: { name: "Rubbish Bin", label: "BIN" },
    go: ({ navigate }) => void navigate({ to: "/rubbish" }),
  },
  repairs: {
    label: "Repairs",
    group: "Maintain",
    description: "Broken links, labels and codes.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/repairs" }),
  },
  agenda: {
    label: "Agenda",
    group: "Write",
    description: "Every open todo, across every page.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/agenda" }),
  },
  conflicts: {
    label: "Conflicts",
    group: "Maintain",
    description: "Sync copies waiting to be resolved.",
    shortcut: null,
    showsSheaf: false,
    feature: null,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/conflicts" }),
  },
};

/** Header nav: the core three. Everything else lives in Contents. */
export const CORE_NAV: readonly CodexView[] = ["folio", "tasking", "gazetteer"];

export function isCoreView(view: CodexView): boolean {
  const root = VIEW_REGISTRY[view].navRoot;
  return root !== null && CORE_NAV.includes(root);
}

export function contentsGroups(
  features: FeatureFlags,
): Array<{ group: ContentsGroup; views: CodexView[] }> {
  const views = enabledNavItems(
    (Object.keys(VIEW_REGISTRY) as CodexView[]).filter(
      (v) => VIEW_REGISTRY[v].group !== null && VIEW_REGISTRY[v].go !== null,
    ),
    features,
  );
  return CONTENTS_GROUPS.map((group) => ({
    group,
    views: views.filter((v) => VIEW_REGISTRY[v].group === group),
  })).filter((g) => g.views.length > 0);
}

export const MOBILE_NAV: readonly CodexView[] = [
  "atrium",
  "gazetteer",
  "academic",
  "bases",
  "feeds",
  "constellation",
  "rubbish",
];

export function enabledNavItems(
  items: readonly CodexView[],
  features: FeatureFlags,
): CodexView[] {
  return items.filter((view) => {
    const feature = VIEW_REGISTRY[view].feature;
    return feature === null || features[feature];
  });
}

export function goToView(view: CodexView, deps: ViewNavDeps): void {
  const go = VIEW_REGISTRY[view].go;
  if (!go) return;
  if (view === "folio" || view === "constellation") {
    go(deps);
    return;
  }
  deps.leaveWorkspace(() => go(deps));
}
