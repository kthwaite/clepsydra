import { useMemo, useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import type { GraphEdge, GraphNode } from "#/api/types";
import { ForceGraph } from "#/components/ForceGraph";
import { Button } from "#/components/ui/button";
import { applyFilters } from "./constellation-filters";

export const MOBILE_GRAPH_DENSITY_THRESHOLD = 18;

type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };
type ViewMode = "graph" | "list";

export interface MobileConstellationProps {
  graph: Graph;
  anchorId: string | null;
  depth: 1 | 2;
  hideDaily: boolean;
  orphansVisible: boolean;
  onAnchorChange: (anchorId: string | null) => void;
  onDepthChange: (depth: 1 | 2) => void;
  onHideDailyChange: (hidden: boolean) => void;
  onOrphansVisibleChange: (visible: boolean) => void;
  onOpen: (node: GraphNode) => void;
}

const sheetButtonClass =
  "cl-mono inline-flex min-h-11 items-center justify-center px-4 text-[10px] uppercase tracking-[0.12em] text-ink-2 outline-none transition-colors data-[hovered]:bg-highlight data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent";

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
  anchorId,
  depth,
  hideDaily,
  orphansVisible,
  onAnchorChange,
  onDepthChange,
  onHideDailyChange,
  onOrphansVisibleChange,
  onOpen,
}: MobileConstellationProps) {
  const [mode, setMode] = useState<ViewMode>("graph");
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
        orphansVisible,
      }),
    [graph, anchorId, depth, hideDaily, orphansVisible],
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
        .sort(
          (a, b) => b.degree - a.degree || compareNodes(a.node, b.node),
        )
        .slice(0, 6),
      orphans: visibleGraph.nodes
        .filter((node) => !connected.has(node.id))
        .sort(compareNodes),
    };
  }, [visibleGraph.edges, visibleGraph.nodes]);

  const needsAnchor =
    anchorId === null && graph.nodes.length > MOBILE_GRAPH_DENSITY_THRESHOLD;

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper text-ink">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-rule px-4 py-2">
        <h1 className="font-sans text-[17px] font-black uppercase tracking-[0.04em]">
          Constellation<span className="text-accent"> / </span>Map
        </h1>
        <span className="cl-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
          {visibleGraph.nodes.length} pages · {visibleGraph.edges.length} links
        </span>
      </header>

      <section
        aria-label="Constellation controls"
        className="shrink-0 space-y-3 border-b border-rule-soft px-4 py-3"
      >
        <label className="block">
          <span className="cl-mono mb-1 block text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            Anchor page
          </span>
          <select
            aria-label="Anchor page"
            className="cl-mono min-h-11 w-full border border-rule bg-paper-2 px-3 text-[12px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            value={anchorId ?? ""}
            onChange={(event) =>
              onAnchorChange(event.target.value || null)
            }
          >
            <option value="" disabled>
              Choose a page to focus the map
            </option>
            {anchorOptions.map((node) => (
              <option key={node.id} value={node.id}>
                {nodeLabel(node)} · {node.path}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <span className="cl-mono mr-1 text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            Depth
          </span>
          {([1, 2] as const).map((value) => (
            <Button
              key={value}
              aria-label={`Depth ${value}`}
              aria-pressed={depth === value}
              className="min-h-11 min-w-11"
              variant={depth === value ? "primary" : "secondary"}
              onPress={() => onDepthChange(value)}
            >
              {value}
            </Button>
          ))}
          <label className="cl-mono ml-auto inline-flex min-h-11 items-center gap-2 text-[10px] text-ink-2">
            <input
              type="checkbox"
              role="switch"
              checked={hideDaily}
              onChange={(event) => onHideDailyChange(event.target.checked)}
            />
            Hide journals
          </label>
          <label className="cl-mono inline-flex min-h-11 items-center gap-2 text-[10px] text-ink-2">
            <input
              type="checkbox"
              role="switch"
              checked={orphansVisible}
              onChange={(event) =>
                onOrphansVisibleChange(event.target.checked)
              }
            />
            Show orphans
          </label>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Button
            aria-label="Graph view"
            aria-pressed={mode === "graph"}
            className="min-h-11"
            variant={mode === "graph" ? "primary" : "secondary"}
            onPress={() => setMode("graph")}
          >
            Graph
          </Button>
          <Button
            aria-label="List view"
            aria-pressed={mode === "list"}
            className="min-h-11"
            variant={mode === "list" ? "primary" : "secondary"}
            onPress={() => setMode("list")}
          >
            List
          </Button>
          <Button
            aria-label="Hubs and orphans"
            aria-haspopup="dialog"
            className="min-h-11"
            onPress={() => setDetailsOpen(true)}
          >
            Details
          </Button>
        </div>
      </section>

      <div className="cl-noscroll min-h-0 flex-1 overflow-y-auto">
        {mode === "graph" ? (
          needsAnchor ? (
            <div className="flex min-h-full items-center justify-center px-6 py-12 text-center">
              <div className="max-w-sm border-y border-rule py-6">
                <p className="font-sans text-base font-semibold text-ink">
                  Select an anchor to plot this constellation.
                </p>
                <p className="cl-mono mt-2 text-[10px] leading-relaxed text-ink-mute">
                  All {graph.nodes.length} pages remain available. Choose an
                  anchor above, or use List view to browse every visible page.
                </p>
              </div>
            </div>
          ) : (
            <div className="h-full min-h-[18rem] touch-none bg-paper-2">
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
              <p className="cl-marg px-6 py-12 text-center">
                ∅ no pages match these controls.
              </p>
            ) : null}
            <ul
              aria-label="Visible constellation pages"
              className="divide-y divide-rule-soft"
            >
              {sortedVisibleNodes.map((node) => {
                const title = nodeLabel(node);
                return (
                  <li key={node.id} className="px-4 py-3">
                    <article className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                      <div className="min-w-0">
                        <h2 className="font-sans text-[15px] font-semibold leading-snug text-ink">
                          {title}
                        </h2>
                        <p className="cl-mono mt-1 break-all text-[10px] leading-relaxed text-ink-mute">
                          {node.path}
                        </p>
                      </div>
                      <Button
                        aria-label={`Open ${title}`}
                        className="min-h-11 self-start"
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

      <ModalOverlay
        isOpen={detailsOpen}
        isDismissable
        onOpenChange={setDetailsOpen}
        className="fixed inset-0 z-50 flex justify-end bg-foreground/30"
      >
        <Modal className="h-dvh w-full max-w-md bg-paper-2 shadow-lg outline-none">
          <Dialog
            aria-label="Constellation details"
            className="flex h-full min-h-0 flex-col outline-none"
          >
            <div className="flex min-h-11 shrink-0 items-stretch border-b border-rule pl-4">
              <Heading
                slot="title"
                className="cl-mono flex min-w-0 flex-1 items-center text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-2"
              >
                Hubs and orphans
              </Heading>
              <AriaButton
                aria-label="Close details"
                className={sheetButtonClass}
                onPress={() => setDetailsOpen(false)}
              >
                Close
              </AriaButton>
            </div>

            <div className="cl-noscroll min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <section>
                <h2 className="cl-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-2">
                  Hubs by degree
                </h2>
                {hubs.length > 0 ? (
                  <ol
                    aria-label="Hubs by degree"
                    className="mt-2 divide-y divide-rule-soft border-y border-rule-soft"
                  >
                    {hubs.map(({ node, degree }) => (
                      <li key={node.id}>
                        <AriaButton
                          className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 text-left outline-none data-[hovered]:bg-highlight data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent"
                          onPress={() => onOpen(node)}
                        >
                          <span className="truncate font-sans text-sm font-semibold">
                            {nodeLabel(node)}
                          </span>
                          <span className="cl-mono text-[10px] text-ink-mute">
                            {degree} {degree === 1 ? "link" : "links"}
                          </span>
                        </AriaButton>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="cl-marg mt-2">No connexions yet.</p>
                )}
              </section>

              <section>
                <h2 className="cl-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-2">
                  Orphans · {orphans.length}
                </h2>
                <ul
                  aria-label="Orphan pages"
                  className="mt-2 divide-y divide-rule-soft border-y border-rule-soft"
                >
                  {orphans.map((node) => (
                    <li key={node.id}>
                      <AriaButton
                        className="min-h-11 w-full px-2 text-left font-sans text-sm font-semibold outline-none data-[hovered]:bg-highlight data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent"
                        onPress={() => onOpen(node)}
                      >
                        {nodeLabel(node)}
                      </AriaButton>
                    </li>
                  ))}
                </ul>
                {orphans.length === 0 ? (
                  <p className="cl-marg mt-2">
                    All visible pages connect to the body of work.
                  </p>
                ) : null}
              </section>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
