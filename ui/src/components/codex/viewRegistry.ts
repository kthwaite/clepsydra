import type { useNavigate } from "@tanstack/react-router";
import type { CodexView } from "#/components/codex/useCodexView";
import type {
  ActivateTabWithFolioHistory,
  LeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";
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

interface ViewDescriptor {
  /** Rail entry text and the footer's VIEW label. */
  label: string;
  /** Footer FILE code; null = derive from the active folio's path. */
  folioCode: string | null;
  showsSheaf: boolean;
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
    label: "ATRIUM",
    folioCode: "ATRIUM",
    showsSheaf: false,
    navRoot: "atrium",
    mobile: { name: "Atrium", label: "ATR" },
    go: ({ navigate }) => void navigate({ to: "/" }),
  },
  folio: {
    label: "FOLIO",
    folioCode: null,
    showsSheaf: true,
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
    label: "LAUNCHER",
    folioCode: "—",
    showsSheaf: true,
    navRoot: "folio",
    mobile: null,
    go: null,
  },
  constellation: {
    label: "CONSTELLATION",
    folioCode: "GRAPH",
    showsSheaf: false,
    navRoot: "constellation",
    mobile: { name: "Constellation", label: "GRAPH" },
    go: ({ openTab }) => openTab("graph"),
  },
  gazetteer: {
    label: "GAZETTEER",
    folioCode: "INDEX",
    showsSheaf: true,
    navRoot: "gazetteer",
    mobile: { name: "Gazetteer", label: "GAZ" },
    go: ({ navigate }) => void navigate({ to: "/gazetteer" }),
  },
  tasking: {
    label: "TASKING",
    folioCode: "TASKING",
    showsSheaf: true,
    navRoot: "tasking",
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/tasking" }),
  },
  academic: {
    label: "ACADEMIC",
    folioCode: "ACADEMIC",
    showsSheaf: false,
    navRoot: "academic",
    mobile: { name: "Academic", label: "ACAD" },
    go: ({ navigate }) => void navigate({ to: "/academic" }),
  },
  bases: {
    label: "BASES",
    folioCode: "BASES",
    showsSheaf: false,
    navRoot: "bases",
    mobile: { name: "Bases", label: "BASE" },
    go: ({ navigate }) => void navigate({ to: "/bases" }),
  },
  feeds: {
    label: "FEEDS",
    folioCode: "FEEDS",
    showsSheaf: false,
    navRoot: "feeds",
    mobile: { name: "Feeds", label: "FEED" },
    go: ({ navigate }) => void navigate({ to: "/feeds" }),
  },
  docs: {
    label: "DOCS",
    folioCode: "DOC-001",
    showsSheaf: false,
    navRoot: "docs",
    mobile: null,
    go: ({ navigate }) =>
      void navigate({ to: "/docs/$slug", params: { slug: DEFAULT_DOC_SLUG } }),
  },
  archive: {
    label: "ARCHIVE",
    folioCode: "ARCHIVE",
    showsSheaf: false,
    fullPage: true,
    navRoot: null,
    mobile: null,
    go: null,
  },
  rubbish: {
    label: "RUBBISH BIN",
    folioCode: "RUBBISH",
    showsSheaf: false,
    navRoot: "rubbish",
    mobile: { name: "Rubbish Bin", label: "BIN" },
    go: ({ navigate }) => void navigate({ to: "/rubbish" }),
  },
  repairs: {
    label: "REPAIRS",
    folioCode: "REPAIRS",
    showsSheaf: false,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/repairs" }),
  },
  agenda: {
    label: "AGENDA",
    folioCode: "AGENDA",
    showsSheaf: false,
    navRoot: null,
    mobile: null,
    go: ({ navigate }) => void navigate({ to: "/agenda" }),
  },
};

/** Header rail order with diegetic index = position (pad2). */
export const DESKTOP_NAV: readonly CodexView[] = [
  "atrium",
  "folio",
  "gazetteer",
  "constellation",
  "tasking",
  "academic",
  "bases",
  "feeds",
  "docs",
  "rubbish",
];

export const MOBILE_NAV: readonly CodexView[] = [
  "atrium",
  "gazetteer",
  "academic",
  "bases",
  "feeds",
  "constellation",
  "rubbish",
];

export function goToView(view: CodexView, deps: ViewNavDeps): void {
  const go = VIEW_REGISTRY[view].go;
  if (!go) return;
  if (view === "folio" || view === "constellation") {
    go(deps);
    return;
  }
  deps.leaveWorkspace(() => go(deps));
}
