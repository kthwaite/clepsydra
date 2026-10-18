import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { GraphNode } from "#/api/types";
import {
  applyFilters,
  type ConstellationGraph,
  neighborhood,
} from "#/components/codex/constellation-filters";
import { Section } from "#/components/codex/Section";
import { ForceGraph, KindGlyph } from "#/components/ForceGraph";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { BottomSheet } from "#/components/ui/sheet";
import { Switch } from "#/components/ui/switch";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { KINDS, kindDisplayLabel } from "#/lib/kind";
import { useConstellationStore } from "#/store/constellation";

interface ConstellationViewProps {
  graph: ConstellationGraph;
  activeAnchorId: string | null;
  onOpen: (node: GraphNode) => void;
  mobile?: boolean;
}

const label = (node: GraphNode) => node.title || node.path;
const segment = cn(
  "min-h-11 min-w-11 rounded-full px-3 text-[14px] aria-pressed:bg-raise aria-pressed:text-ink text-mute hover:text-ink",
  FOCUS_RING_NATIVE,
);

/** Both surfaces share filtering and selection so switching breakpoints preserves context. */
export function ConstellationView({
  graph,
  activeAnchorId,
  onOpen,
  mobile = false,
}: ConstellationViewProps) {
  const state = useConstellationStore();
  const {
    selectedAnchorId,
    selectedNodeId,
    depth,
    focusHops,
    hiddenKinds,
    propertyRefsVisible,
    orphansVisible,
    mode,
    groupBy,
    setSelectedAnchorId,
    setSelectedNodeId,
    setDepth,
  } = state;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarId = useId();
  const eligible = useMemo(
    () =>
      applyFilters(graph, {
        hiddenKinds,
        propertyRefsVisible,
        orphansVisible,
        depth: null,
        anchorId: null,
      }),
    [graph, hiddenKinds, propertyRefsVisible, orphansVisible],
  );
  const anchorCandidate = selectedAnchorId ?? activeAnchorId;
  const anchorId = eligible.nodes.some((node) => node.id === anchorCandidate)
    ? anchorCandidate
    : null;
  const visible = useMemo(
    () =>
      applyFilters(eligible, {
        hiddenKinds: [],
        propertyRefsVisible: true,
        orphansVisible: true,
        depth,
        anchorId,
      }),
    [eligible, depth, anchorId],
  );
  const selectedNode = visible.nodes.find((node) => node.id === selectedNodeId);
  const validHover = visible.nodes.some((node) => node.id === hoveredId)
    ? hoveredId
    : null;
  const focusId = validHover ?? selectedNode?.id ?? null;
  const focusedIds = useMemo(
    () => (focusId ? neighborhood(visible.edges, focusId, focusHops) : null),
    [visible.edges, focusId, focusHops],
  );
  const sortedNodes = useMemo(
    () =>
      [...visible.nodes].sort(
        (a, b) =>
          label(a).localeCompare(label(b)) || a.path.localeCompare(b.path),
      ),
    [visible.nodes],
  );
  const anchorOptions = useMemo(
    () => [...eligible.nodes].sort((a, b) => label(a).localeCompare(label(b))),
    [eligible.nodes],
  );
  const { hubs, orphans } = useMemo(() => {
    const degrees = new Map<string, number>();
    for (const edge of visible.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }
    return {
      hubs: visible.nodes
        .filter((node) => degrees.has(node.id))
        .map((node) => ({ node, degree: degrees.get(node.id) ?? 0 }))
        .sort(
          (a, b) =>
            b.degree - a.degree || label(a.node).localeCompare(label(b.node)),
        )
        .slice(0, 6),
      orphans: visible.nodes.filter((node) => !degrees.has(node.id)),
    };
  }, [visible]);
  useEffect(() => {
    if (!anchorId) {
      if (selectedAnchorId) setSelectedAnchorId(null);
      if (depth !== null) setDepth(null);
    }
    if (selectedNodeId && !selectedNode) setSelectedNodeId(null);
    if (hoveredId && !validHover) setHoveredId(null);
  }, [
    anchorId,
    selectedAnchorId,
    depth,
    selectedNodeId,
    selectedNode,
    hoveredId,
    validHover,
    setSelectedAnchorId,
    setSelectedNodeId,
    setDepth,
  ]);
  const clearFocus = useCallback(() => {
    setHoveredId(null);
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearFocus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearFocus]);
  const selectNode = useCallback(
    (node: GraphNode) => {
      setHoveredId(null);
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );
  const hoverNode = useCallback(
    (node: GraphNode | null) => setHoveredId(node?.id ?? null),
    [],
  );

  const controls = (
    <>
      <Section compact label="Filters">
        <div className="flex flex-col gap-2">
          <Select
            aria-label="Anchor page"
            className="[&>button]:min-h-11"
            value={anchorId ?? ""}
            onChange={(key) => {
              setSelectedAnchorId(key ? String(key) : null);
              if (!key) setDepth(null);
            }}
          >
            <SelectItem id="">Use open page / all pages</SelectItem>
            {anchorOptions.map((node) => (
              <SelectItem
                key={node.id}
                id={node.id}
                textValue={`${label(node)} · ${node.path}`}
              >
                {label(node)} · {node.path}
              </SelectItem>
            ))}
          </Select>
          <fieldset
            aria-label="Depth"
            className="m-0 flex flex-wrap items-center gap-1 border-0 p-0"
          >
            <legend className="text-[14px] text-mute">Depth</legend>
            {([1, 2, null] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                aria-label={`Depth ${value ?? "All"}`}
                aria-pressed={depth === value}
                disabled={value !== null && !anchorId}
                onClick={() => setDepth(value)}
                className={cn(segment, "disabled:opacity-40")}
              >
                {value ?? "All"}
              </button>
            ))}
          </fieldset>
          <p className="m-0 text-[13px] text-mute">
            Depth limits the map. Focus highlights neighbours without hiding
            pages.
          </p>
          <Switch
            className="min-h-11"
            isSelected={orphansVisible}
            onChange={state.setOrphansVisible}
          >
            Show orphans
          </Switch>
          <Switch
            className="min-h-11"
            isSelected={propertyRefsVisible}
            onChange={state.setPropertyRefsVisible}
          >
            Property references
          </Switch>
          <fieldset className="m-0 grid grid-cols-2 gap-1 border-0 p-0">
            <legend className="mb-2 text-[14px] text-mute">Kinds</legend>
            {KINDS.map((kind) => (
              <Switch
                key={kind}
                className="min-h-11 px-1 text-[13px]"
                isSelected={!hiddenKinds.includes(kind)}
                onChange={(value) => state.setKindVisible(kind, value)}
              >
                {kindDisplayLabel(kind)}
              </Switch>
            ))}
          </fieldset>
        </div>
      </Section>
      <Section compact label="Hubs">
        <ul aria-label="Hubs by degree" className="m-0 list-none p-0">
          {hubs.map(({ node, degree }) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => selectNode(node)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-md text-left text-[14px] hover:text-accent",
                  FOCUS_RING_NATIVE,
                )}
              >
                <span className="min-w-0 flex-1 truncate">{label(node)}</span>
                <span className="text-mute">{degree}</span>
              </button>
            </li>
          ))}
        </ul>
        {hubs.length === 0 ? (
          <p className="text-[14px] text-mute">No connexions yet.</p>
        ) : null}
      </Section>
      <Section compact label="Orphans">
        <ul aria-label="Orphan pages" className="m-0 list-none p-0">
          {orphans.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => selectNode(node)}
                className={cn(
                  "min-h-11 w-full truncate rounded-md text-left text-[14px] hover:text-accent",
                  FOCUS_RING_NATIVE,
                )}
              >
                {label(node)}
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <Section compact label="Legend">
        <div className="flex flex-wrap gap-3">
          {KINDS.filter((kind) =>
            graph.nodes.some((node) => node.kind === kind),
          ).map((kind) => (
            <span key={kind} className="flex items-center gap-2 text-[13px]">
              <KindGlyph kind={kind} />
              {kindDisplayLabel(kind)}
            </span>
          ))}
        </div>
      </Section>
    </>
  );

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-ground text-ink",
        mobile ? "px-4 py-3" : "px-10 pt-7 pb-8",
      )}
    >
      <section
        aria-label="Constellation controls"
        className="flex shrink-0 flex-wrap items-center gap-3 pb-3"
      >
        <fieldset
          aria-label="View"
          className="m-0 flex rounded-full border-0 bg-sink p-1"
        >
          {(["graph", "list"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`${value === "graph" ? "Graph" : "List"} view`}
              aria-pressed={mode === value}
              className={segment}
              onClick={() => {
                setHoveredId(null);
                state.setMode(value);
              }}
            >
              {value === "graph" ? "Graph" : "List"}
            </button>
          ))}
        </fieldset>
        <fieldset
          aria-label="Focus distance"
          className="m-0 flex items-center gap-1 border-0 p-0"
        >
          <legend className="text-[13px] text-mute">Focus</legend>
          {([1, 2] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`Focus ${value} hops`}
              aria-pressed={focusHops === value}
              className={segment}
              onClick={() => state.setFocusHops(value)}
            >
              {value} hop{value === 2 ? "s" : ""}
            </button>
          ))}
        </fieldset>
        <Select
          aria-label="Group by"
          className="w-auto min-w-36 [&>button]:min-h-11"
          value={groupBy}
          onChange={(key) => {
            if (key === "none" || key === "kind" || key === "folder")
              state.setGroupBy(key);
          }}
        >
          <SelectItem id="none">No grouping</SelectItem>
          <SelectItem id="kind">Kind</SelectItem>
          <SelectItem id="folder">Top-level folder</SelectItem>
        </Select>
        {mobile ? (
          <Button
            className="min-h-11"
            aria-label="Filters and details"
            onPress={() => setDetailsOpen(true)}
          >
            Filters and details
          </Button>
        ) : (
          <IconButton
            className="min-h-11 min-w-11"
            aria-label={
              sidebarOpen ? "Hide right sidebar" : "Show right sidebar"
            }
            aria-expanded={sidebarOpen}
            aria-controls={sidebarId}
            onPress={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
          </IconButton>
        )}
      </section>
      <div className="shrink-0 pb-2 text-[14px]">
        <p className="m-0 pb-2 text-mute">
          {visible.nodes.length} nodes · {visible.edges.length} edges
        </p>
        <div
          className={cn(
            "grid items-center gap-2",
            mobile ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_auto]",
          )}
        >
          <span
            className="block min-h-6 min-w-0 truncate"
            title={selectedNode ? label(selectedNode) : undefined}
          >
            {selectedNode
              ? `Focused: ${label(selectedNode)}`
              : "Select a page to focus; Open to navigate."}
          </span>
          <div className="flex h-11 items-center gap-2">
            <Button
              className="min-h-11"
              isDisabled={!selectedNode}
              onPress={() => {
                if (selectedNode) onOpen(selectedNode);
              }}
            >
              Open focused page
            </Button>
            <Button
              className="min-h-11"
              isDisabled={!selectedNode && !validHover}
              onPress={clearFocus}
            >
              Clear focus
            </Button>
          </div>
        </div>
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-6",
          !mobile && sidebarOpen
            ? "grid-cols-[minmax(0,1fr)_288px]"
            : "grid-cols-1",
        )}
      >
        <div className="min-h-0 min-w-0 overflow-auto rounded-2xl bg-raise">
          {visible.nodes.length === 0 ? (
            <p className="px-6 py-12 text-center text-[14px] text-mute">
              No pages match these controls.
            </p>
          ) : mode === "graph" ? (
            <div className="h-full min-h-[18rem] overflow-hidden p-2">
              <ForceGraph
                nodes={visible.nodes}
                edges={visible.edges}
                groupBy={groupBy}
                focusedIds={focusedIds}
                selectedNodeId={selectedNode?.id ?? null}
                onNodeSelect={selectNode}
                onNodeHover={hoverNode}
              />
            </div>
          ) : (
            <ul
              aria-label="Visible constellation pages"
              className="m-0 flex list-none flex-col gap-2 p-3"
            >
              {sortedNodes.map((node) => (
                <li
                  key={node.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl bg-ground p-3",
                    focusedIds &&
                      !focusedIds.has(node.id) &&
                      selectedNode?.id !== node.id &&
                      "opacity-30",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`Focus ${label(node)}`}
                    aria-pressed={selectedNode?.id === node.id}
                    onClick={() => selectNode(node)}
                    onMouseEnter={() => hoverNode(node)}
                    onMouseLeave={() => hoverNode(null)}
                    className={cn(
                      "min-h-11 min-w-0 flex-1 rounded-md text-left",
                      FOCUS_RING_NATIVE,
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <KindGlyph kind={node.kind} />
                      <span className="min-w-0 break-words text-[15px]">
                        {label(node)}
                      </span>
                    </span>
                    <span className="block truncate text-[13px] text-mute">
                      {node.path}
                    </span>
                  </button>
                  <Button
                    aria-label={`Open ${label(node)}`}
                    className="min-h-11 shrink-0"
                    onPress={() => onOpen(node)}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!mobile ? (
          <aside
            id={sidebarId}
            aria-label="Constellation details"
            hidden={!sidebarOpen}
            className={cn(
              "min-h-0 min-w-0 flex-col gap-6 overflow-auto",
              sidebarOpen ? "flex" : "hidden",
            )}
          >
            {controls}
          </aside>
        ) : null}
      </div>
      {mobile ? (
        <BottomSheet
          isOpen={detailsOpen}
          onOpenChange={setDetailsOpen}
          aria-label="Constellation details"
        >
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-serif text-[28px] font-normal">
                Filters and details
              </h2>
              <Button
                className="min-h-11"
                aria-label="Close details"
                onPress={() => setDetailsOpen(false)}
              >
                Close
              </Button>
            </div>
            {controls}
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
