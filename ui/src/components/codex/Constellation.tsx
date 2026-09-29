import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useGraph } from "#/api/index";
import type { GraphNode } from "#/api/types";
import { applyFilters } from "#/components/codex/constellation-filters";
import { MobileConstellation } from "#/components/codex/MobileConstellation";
import { Section } from "#/components/codex/Section";
import { ForceGraph, KindGlyph } from "#/components/ForceGraph";
import { IconButton } from "#/components/ui/icon-button";
import { Switch } from "#/components/ui/switch";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { type Kind, kindDisplayLabel } from "#/lib/kind";
import { pluralize } from "#/lib/string";
import { useConstellationStore } from "#/store/constellation";
import { useWorkspaceStore } from "#/store/workspace";

export function Constellation() {
  const { data: graph, isLoading } = useGraph();
  const openTab = useOpenTab();
  const isMobile = useMobileLayout();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarId = useId();

  const {
    selectedAnchorId,
    depth,
    hideDaily,
    hideTasks,
    orphansVisible,
    mode,
    setSelectedAnchorId,
    setDepth,
    setHideDaily,
    setHideTasks,
    setOrphansVisible,
    setMode,
  } = useConstellationStore();

  const activeTabId2 = useWorkspaceStore((s) => s.activeTabId);
  const wsTabs = useWorkspaceStore((s) => s.tabs);
  const anchorPath = wsTabs.find(
    (t) => t.id === activeTabId2 && t.type === "page",
  )?.path;
  const activeAnchorId = useMemo(
    () => graph?.nodes.find((n) => n.path === anchorPath)?.id ?? null,
    [graph, anchorPath],
  );
  const anchorId = useMemo(
    () =>
      selectedAnchorId &&
      graph?.nodes.some((node) => node.id === selectedAnchorId)
        ? selectedAnchorId
        : activeAnchorId,
    [activeAnchorId, graph, selectedAnchorId],
  );

  const filtered = useMemo(
    () =>
      graph
        ? applyFilters(graph, {
            orphansVisible,
            hideDaily,
            hideTasks,
            depth,
            anchorId,
          })
        : { nodes: [], edges: [] },
    [graph, orphansVisible, hideDaily, hideTasks, depth, anchorId],
  );

  if (isLoading || !graph) {
    return (
      <p className="p-10 text-[14px] text-mute">Plotting the constellation…</p>
    );
  }
  if (graph.nodes.length === 0) {
    return (
      <p className="p-10 text-[14px] text-mute">
        No folios to plot. Inscribe a folio first.
      </p>
    );
  }

  const handle = (node: GraphNode) =>
    openTab("page", node.path, node.title || node.path);
  if (isMobile) {
    return (
      <MobileConstellation
        graph={graph}
        mode={mode}
        anchorId={anchorId}
        depth={depth === 2 ? 2 : 1}
        hideDaily={hideDaily}
        hideTasks={hideTasks}
        orphansVisible={orphansVisible}
        onModeChange={setMode}
        onAnchorChange={setSelectedAnchorId}
        onDepthChange={(nextDepth) => setDepth(nextDepth)}
        onHideDailyChange={setHideDaily}
        onHideTasksChange={setHideTasks}
        onOrphansVisibleChange={setOrphansVisible}
        onOpen={handle}
      />
    );
  }
  const degrees = countDegrees(filtered.edges);
  const hubs = [...filtered.nodes]
    .map((n) => ({ ...n, degree: degrees.get(n.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 6);
  const anchorNode = anchorId
    ? graph.nodes.find((node) => node.id === anchorId)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-ground text-ink">
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] px-10 pt-7 pb-8",
          sidebarOpen
            ? "grid-cols-[minmax(0,1fr)_272px] gap-12"
            : "grid-cols-[minmax(0,1fr)]",
        )}
      >
        <div className="relative min-h-0 min-w-0 overflow-hidden rounded-2xl bg-raise px-[22px] py-[18px]">
          <IconButton
            aria-label={sidebarOpen ? "Hide right sidebar" : "Show right sidebar"}
            aria-expanded={sidebarOpen}
            aria-controls={sidebarId}
            onPress={() => setSidebarOpen((open) => !open)}
            className="absolute top-3 right-3 z-10 bg-sink"
          >
            {sidebarOpen ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
          </IconButton>
          <ForceGraph
            nodes={filtered.nodes}
            edges={filtered.edges}
            onNodeClick={handle}
          />
        </div>

        <aside
          id={sidebarId}
          aria-label="Constellation details"
          hidden={!sidebarOpen}
          className={cn(
            "cl-noscroll min-h-0 min-w-0 flex-col gap-7 overflow-auto",
            sidebarOpen ? "flex" : "hidden",
          )}
        >
          <p className="m-0 text-[14px] text-mute">
            {filtered.nodes.length} {pluralize(filtered.nodes.length, "node")} ·{" "}
            {filtered.edges.length} {pluralize(filtered.edges.length, "edge")}
          </p>
          <Section compact label="Hubs">
            {hubs.length > 0 ? (
              <div className="flex flex-col">
                {hubs.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => handle(h)}
                    className={cn(
                      "flex h-8 w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent p-0 text-left text-[14px] text-ink hover:text-accent",
                      FOCUS_RING_NATIVE,
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {h.title || h.path}
                    </span>
                    <span className="text-[13px] text-mute tabular-nums">
                      {h.degree}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="m-0 text-[14px] text-mute">No connexions yet.</p>
            )}
          </Section>

          <Section compact label="Filters">
            <div className="flex flex-col gap-1">
              <Switch
                className="bg-transparent px-0 text-[14px]"
                isSelected={orphansVisible}
                onChange={setOrphansVisible}
              >
                Show orphans
              </Switch>
              <Switch
                className="bg-transparent px-0 text-[14px]"
                isSelected={hideDaily}
                onChange={setHideDaily}
              >
                Hide journals
              </Switch>
              <Switch
                className="bg-transparent px-0 text-[14px]"
                isSelected={hideTasks}
                onChange={setHideTasks}
              >
                Hide tasks
              </Switch>
              <div className="mt-2.5 flex items-center gap-3 text-[14px]">
                <span id="constellation-depth-label">Depth</span>
                <fieldset
                  aria-labelledby="constellation-depth-label"
                  className="m-0 flex min-w-0 gap-0.5 rounded-full border-0 bg-sink p-[3px]"
                >
                  {([1, 2, null] as const).map((d) => {
                    const needsAnchor = d != null && !anchorId;
                    const selected = depth === d;
                    return (
                      <button
                        key={String(d)}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setDepth(d)}
                        disabled={needsAnchor}
                        title={
                          needsAnchor
                            ? "Open a page tab to use depth"
                            : undefined
                        }
                        className={cn(
                          "h-[30px] min-w-11 rounded-full border-0 px-3 text-[13px] disabled:cursor-not-allowed disabled:opacity-40",
                          selected
                            ? "bg-raise font-medium text-ink shadow-sm"
                            : "bg-transparent text-mute enabled:hover:text-ink",
                          FOCUS_RING_NATIVE,
                        )}
                      >
                        {d ?? "All"}
                      </button>
                    );
                  })}
                </fieldset>
              </div>
              {anchorNode ? (
                <span className="mt-1.5 text-[12.5px] leading-normal text-mute">
                  From{" "}
                  <span className="text-ink">
                    {anchorNode.title || anchorNode.path}
                  </span>
                  {anchorId === activeAnchorId ? ", the open page" : null}
                </span>
              ) : null}
            </div>
          </Section>

          <Section compact pip="dim" label="Legend">
            <div className="flex flex-col gap-2.5">
              {LEGEND_KINDS.map((kind) => (
                <span
                  key={kind}
                  className="flex items-center gap-3 text-[13.5px] text-ink-2"
                >
                  <KindGlyph kind={kind} />
                  {kindDisplayLabel(kind)}
                </span>
              ))}
            </div>
          </Section>
        </aside>
      </div>
    </div>
  );
}

/** The node shapes the map draws, as the legend names them. */
const LEGEND_KINDS: readonly Kind[] = ["PROJECT", "TASK", "JOURNAL", "NOTE"];

function countDegrees(
  edges: { source: string; target: string }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) {
    m.set(e.source, (m.get(e.source) ?? 0) + 1);
    m.set(e.target, (m.get(e.target) ?? 0) + 1);
  }
  return m;
}
