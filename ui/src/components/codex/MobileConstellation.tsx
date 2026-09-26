import { useMemo, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { GraphEdge, GraphNode } from "#/api/types";
import { Section } from "#/components/codex/Section";
import { Tick } from "#/components/codex/Tick";
import { ForceGraph } from "#/components/ForceGraph";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import { BottomSheet } from "#/components/ui/sheet";
import { Switch } from "#/components/ui/switch";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import { pluralize } from "#/lib/string";
import type { ConstellationViewMode } from "#/store/constellation";
import { applyFilters } from "./constellation-filters";

export const MOBILE_GRAPH_DENSITY_THRESHOLD = 18;

type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export interface MobileConstellationProps {
  graph: Graph;
  mode: ConstellationViewMode;
  anchorId: string | null;
  depth: 1 | 2;
  hideDaily: boolean;
  hideTasks?: boolean;
  orphansVisible: boolean;
  onModeChange: (mode: ConstellationViewMode) => void;
  onAnchorChange: (anchorId: string | null) => void;
  onDepthChange: (depth: 1 | 2) => void;
  onHideDailyChange: (hidden: boolean) => void;
  onHideTasksChange?: (hidden: boolean) => void;
  onOrphansVisibleChange: (visible: boolean) => void;
  onOpen: (node: GraphNode) => void;
}

const segmentTrack =
  "m-0 flex min-w-0 gap-0.5 rounded-full border-0 bg-sink p-[3px]";

function segmentClass(selected: boolean): string {
  return cn(
    "h-[38px] min-w-11 rounded-full px-3.5 text-[14px]",
    selected
      ? "bg-raise font-medium text-ink shadow-sm"
      : "text-mute data-[hovered]:text-ink",
    FOCUS_RING,
  );
}

function nodeLabel(node: GraphNode): string {
  return node.title || node.path;
}

function compareNodes(a: GraphNode, b: GraphNode): number {
  const aLabel = nodeLabel(a);
  const bLabel = nodeLabel(b);
  if (aLabel !== bLabel) return aLabel < bLabel ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function countDegrees(edges: GraphEdge[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  return degrees;
}

export function MobileConstellation({
  graph,
  mode,
  anchorId,
  depth,
  hideDaily,
  hideTasks = false,
  orphansVisible,
  onModeChange,
  onAnchorChange,
  onDepthChange,
  onHideDailyChange,
  onHideTasksChange,
  onOrphansVisibleChange,
  onOpen,
}: MobileConstellationProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const anchorOptions = useMemo(
    () => [...graph.nodes].sort(compareNodes),
    [graph.nodes],
  );
  const visibleGraph = useMemo(
    () =>
      applyFilters(graph, {
        anchorId,
        depth: anchorId ? depth : null,
        hideDaily,
        hideTasks,
        orphansVisible,
      }),
    [graph, anchorId, depth, hideDaily, hideTasks, orphansVisible],
  );
  const sortedVisibleNodes = useMemo(
    () => [...visibleGraph.nodes].sort(compareNodes),
    [visibleGraph.nodes],
  );
  const { hubs, orphans } = useMemo(() => {
    const degrees = countDegrees(visibleGraph.edges);
    const connected = new Set(degrees.keys());
    return {
      hubs: visibleGraph.nodes
        .filter((node) => (degrees.get(node.id) ?? 0) > 0)
        .map((node) => ({ node, degree: degrees.get(node.id) ?? 0 }))
        .sort((a, b) => b.degree - a.degree || compareNodes(a.node, b.node))
        .slice(0, 6),
      orphans: visibleGraph.nodes
        .filter((node) => !connected.has(node.id))
        .sort(compareNodes),
    };
  }, [visibleGraph.edges, visibleGraph.nodes]);

  const needsAnchor =
    anchorId === null &&
    visibleGraph.nodes.length > MOBILE_GRAPH_DENSITY_THRESHOLD;

  return (
    <div className="flex h-full min-h-0 flex-col bg-ground text-ink">
      <header className="flex shrink-0 items-end gap-3 px-5 pt-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="truncate font-serif text-[18px] text-mute italic">
              Map · {visibleGraph.nodes.length}{" "}
              {pluralize(visibleGraph.nodes.length, "page")} ·{" "}
              {visibleGraph.edges.length}{" "}
              {pluralize(visibleGraph.edges.length, "link")}
            </span>
          </span>
          <h1 className="m-0 font-serif text-[44px] leading-none">
            Constellation
          </h1>
        </div>
        <Button
          aria-label="Hubs and orphans"
          aria-haspopup="dialog"
          className="min-h-11 shrink-0"
          onPress={() => setDetailsOpen(true)}
        >
          Details
        </Button>
      </header>

      <section
        aria-label="Constellation controls"
        className="flex shrink-0 flex-col gap-2.5 px-4 pt-[18px]"
      >
        <Select
          aria-label="Anchor page"
          className="[&>button]:min-h-11"
          value={anchorId ?? ""}
          onChange={(key) =>
            onAnchorChange(key === null || key === "" ? null : String(key))
          }
        >
          <SelectItem id="" isDisabled>
            Choose a page to focus the map
          </SelectItem>
          {anchorOptions.map((node) => (
            <SelectItem
              key={node.id}
              id={node.id}
              textValue={`${nodeLabel(node)} · ${node.path}`}
            >
              {nodeLabel(node)} · {node.path}
            </SelectItem>
          ))}
        </Select>

        <div className="flex flex-wrap items-center gap-2.5">
          <span
            id="mobile-constellation-depth"
            className="text-[13.5px] text-mute"
          >
            Depth
          </span>
          <fieldset
            aria-labelledby="mobile-constellation-depth"
            className={segmentTrack}
          >
            {([1, 2] as const).map((value) => (
              <AriaButton
                key={value}
                aria-label={`Depth ${value}`}
                aria-pressed={depth === value}
                className={segmentClass(depth === value)}
                onPress={() => onDepthChange(value)}
              >
                {value}
              </AriaButton>
            ))}
          </fieldset>
          <span className="flex-1" />
          <fieldset aria-label="View" className={segmentTrack}>
            <AriaButton
              aria-label="Graph view"
              aria-pressed={mode === "graph"}
              className={segmentClass(mode === "graph")}
              onPress={() => onModeChange("graph")}
            >
              Graph
            </AriaButton>
            <AriaButton
              aria-label="List view"
              aria-pressed={mode === "list"}
              className={segmentClass(mode === "list")}
              onPress={() => onModeChange("list")}
            >
              List
            </AriaButton>
          </fieldset>
        </div>

        <div className="flex flex-wrap gap-2">
          <Switch
            className="h-11"
            isSelected={hideDaily}
            onChange={onHideDailyChange}
          >
            Hide journals
          </Switch>
          {onHideTasksChange ? (
            <Switch
              className="h-11"
              isSelected={hideTasks}
              onChange={onHideTasksChange}
            >
              Hide tasks
            </Switch>
          ) : null}
          <Switch
            className="h-11"
            isSelected={orphansVisible}
            onChange={onOrphansVisibleChange}
          >
            Show orphans
          </Switch>
        </div>
      </section>

      <div className="cl-noscroll min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-4">
        {mode === "graph" ? (
          needsAnchor ? (
            <div className="flex min-h-full items-center justify-center rounded-2xl bg-raise px-6 py-12 text-center">
              <div className="max-w-sm">
                <p className="m-0 font-serif text-[22px] leading-tight text-ink">
                  Select an anchor to plot this constellation.
                </p>
                <p className="mt-2 mb-0 text-[14px] leading-relaxed text-mute">
                  All {graph.nodes.length} pages remain available. Choose an
                  anchor above, or use List view to browse every visible page.
                </p>
              </div>
            </div>
          ) : (
            <div className="h-full min-h-[18rem] touch-none overflow-hidden rounded-2xl bg-raise p-2">
              <ForceGraph
                nodes={visibleGraph.nodes}
                edges={visibleGraph.edges}
                onNodeClick={onOpen}
              />
            </div>
          )
        ) : (
          <div>
            {sortedVisibleNodes.length === 0 ? (
              <p className="m-0 px-6 py-12 text-center text-[14px] text-mute">
                No pages match these controls.
              </p>
            ) : null}
            <ul
              aria-label="Visible constellation pages"
              className="m-0 flex list-none flex-col gap-2 p-0"
            >
              {sortedVisibleNodes.map((node) => {
                const title = nodeLabel(node);
                return (
                  <li
                    key={node.id}
                    className="rounded-[14px] bg-raise py-3 pr-3.5 pl-4"
                  >
                    <article className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                      <div className="flex min-w-0 flex-col gap-[3px]">
                        <h2 className="m-0 text-[15.5px] font-normal leading-snug text-ink">
                          {title}
                        </h2>
                        <p className="m-0 truncate text-[12.5px] text-mute">
                          {node.path}
                        </p>
                      </div>
                      <Button
                        aria-label={`Open ${title}`}
                        className="min-h-11"
                        onPress={() => onOpen(node)}
                      >
                        Open
                      </Button>
                    </article>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <BottomSheet
        isOpen={detailsOpen}
        onOpenChange={setDetailsOpen}
        aria-label="Constellation details"
      >
        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-3">
            <h2 className="m-0 min-w-0 flex-1 font-serif text-[28px] font-normal leading-tight">
              Hubs and orphans
            </h2>
            <Button
              aria-label="Close details"
              className="min-h-11"
              onPress={() => setDetailsOpen(false)}
            >
              Close
            </Button>
          </div>

          <Section compact headingLevel={3} label="Hubs by degree">
            {hubs.length > 0 ? (
              <ol aria-label="Hubs by degree" className="m-0 list-none p-0">
                {hubs.map(({ node, degree }) => (
                  <li key={node.id}>
                    <AriaButton
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-md text-left text-[15.5px] text-ink data-[hovered]:text-accent",
                        FOCUS_RING,
                      )}
                      onPress={() => onOpen(node)}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {nodeLabel(node)}
                      </span>
                      <span className="text-[12.5px] text-mute tabular-nums">
                        {degree} {degree === 1 ? "link" : "links"}
                      </span>
                    </AriaButton>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="m-0 text-[14.5px] text-mute">No connexions yet.</p>
            )}
          </Section>

          <Section
            compact
            pip="dim"
            headingLevel={3}
            label={`Orphans · ${orphans.length}`}
          >
            <ul aria-label="Orphan pages" className="m-0 list-none p-0">
              {orphans.map((node) => (
                <li key={node.id}>
                  <AriaButton
                    className={cn(
                      "flex min-h-11 w-full items-center rounded-md text-left text-[15.5px] text-ink data-[hovered]:text-accent",
                      FOCUS_RING,
                    )}
                    onPress={() => onOpen(node)}
                  >
                    {nodeLabel(node)}
                  </AriaButton>
                </li>
              ))}
            </ul>
            {orphans.length === 0 ? (
              <p className="m-0 text-[14.5px] leading-normal text-mute">
                All visible pages connect to the body of work.
              </p>
            ) : null}
          </Section>
        </div>
      </BottomSheet>
    </div>
  );
}
