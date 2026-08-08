import { useMemo, useState } from "react";
import { useGraph } from "#/api/index";
import type { GraphNode } from "#/api/types";
import { ASCII_COMPASS } from "#/components/codex/ascii";
import { applyFilters } from "#/components/codex/constellation-filters";
import { MobileConstellation } from "#/components/codex/MobileConstellation";
import { ForceGraph } from "#/components/ForceGraph";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { type Kind, kindColorVar } from "#/lib/kind";
import { useWorkspaceStore } from "#/store/workspace";

export function Constellation() {
  const { data: graph, isLoading } = useGraph();
  const openTab = useOpenTab();
  const isMobile = useMobileLayout();

  const [orphansVisible, setOrphansVisible] = useState(true);
  const [hideDaily, setHideDaily] = useState(false);
  const [depth, setDepth] = useState<number | null>(null);
  const [selectedAnchorId, setSelectedAnchorId] = useState<string | null>(null);

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
        ? applyFilters(graph, { orphansVisible, hideDaily, depth, anchorId })
        : { nodes: [], edges: [] },
    [graph, orphansVisible, hideDaily, depth, anchorId],
  );

  if (isLoading || !graph) {
    return <div className="cl-marg p-6">… plotting the constellation …</div>;
  }
  if (graph.nodes.length === 0) {
    return (
      <div className="cl-marg p-6">
        ⁂ no folios to plot. Inscribe a folio first.
      </div>
    );
  }

  const handle = (node: GraphNode) =>
    openTab("page", node.path, node.title || node.path);
  if (isMobile) {
    return (
      <MobileConstellation
        graph={graph}
        anchorId={anchorId}
        depth={depth === 2 ? 2 : 1}
        hideDaily={hideDaily}
        orphansVisible={orphansVisible}
        onAnchorChange={setSelectedAnchorId}
        onDepthChange={(nextDepth) => setDepth(nextDepth)}
        onHideDailyChange={setHideDaily}
        onOrphansVisibleChange={setOrphansVisible}
        onOpen={handle}
      />
    );
  }
  const orphans = filtered.nodes.filter(
    (n) => !filtered.edges.some((e) => e.source === n.id || e.target === n.id),
  );
  const degrees = countDegrees(filtered.edges);
  const hubs = [...filtered.nodes]
    .map((n) => ({ ...n, degree: degrees.get(n.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 6);

  return (
    <div className="grid h-full grid-cols-[1fr_240px] gap-[18px] px-5 py-[14px]">
      {/* CHART */}
      <div className="flex min-h-0 flex-col">
        <div className="mb-1 flex items-baseline justify-between">
          <div>
            <div className="cl-cap cl-cap-wide text-[14px]">CONSTELLATION</div>
            <div className="cl-marg">
              — a map of one's mind, drawn from the connexions —
            </div>
          </div>
          <div className="cl-mono text-[10px] text-ink-mute">
            fig. v · {filtered.nodes.length} nodes · {filtered.edges.length}{" "}
            vertices
          </div>
        </div>
        <hr className="cl-rule-double" />

        {/* the chart */}
        <div className="cl-frame cl-grid-fine relative min-h-0 flex-1 bg-paper">
          {/* registration corners */}
          <div className="absolute left-2 top-2 h-3 w-3 border-l border-t border-rule" />
          <div className="absolute right-2 top-2 h-3 w-3 border-r border-t border-rule" />
          <div className="absolute bottom-2 left-2 h-3 w-3 border-b border-l border-rule" />
          <div className="absolute bottom-2 right-2 h-3 w-3 border-b border-r border-rule" />

          <div className="cl-cap absolute left-4 top-2 text-[9px] text-ink-mute">
            PL. V · CONSTELLATION OF ATTENTION
          </div>
          <div className="cl-mono absolute right-4 top-2 text-[9px]">
            N ↑ · scale 1:1
          </div>

          <div className="absolute bottom-2 right-4">
            <pre className="cl-ascii cl-ascii-faint text-[6px]">
              {ASCII_COMPASS}
            </pre>
          </div>

          <ForceGraph
            nodes={filtered.nodes}
            edges={filtered.edges}
            onNodeClick={handle}
          />
        </div>
      </div>

      {/* SIDEBAR */}
      <aside className="cl-noscroll overflow-auto border-l border-rule-soft pl-4">
        <div className="cl-cap mb-1 text-[9px]">§ Hubs, by degree</div>
        <hr className="cl-rule-soft" />
        <div className="cl-serif mt-1 text-[11px]">
          {hubs.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => handle(h)}
              className="cl-leader mb-[2px] w-full cursor-pointer border-0 bg-transparent p-0 text-left"
            >
              <span className="italic">{h.title || h.path}</span>
              <span className="cl-leader-dots" />
              <span className="cl-mono text-[10px]">{h.degree}</span>
            </button>
          ))}
          {hubs.length === 0 && (
            <p className="cl-marg m-0">No connexions yet.</p>
          )}
        </div>

        <div className="cl-cap mb-1 mt-4 text-[9px]">
          § Orphans · {orphans.length}
        </div>
        <hr className="cl-rule-soft" />
        {orphans.length === 0 ? (
          <p className="cl-marg mt-1">
            All folios connect to the body of work.
          </p>
        ) : (
          <p className="cl-marg mt-1">
            {orphans.length} folios stand alone, with no connexion to the body
            of work — reader, attend to them, or release them.
          </p>
        )}

        <div className="cl-cap mb-1 mt-4 text-[9px]">§ Filters</div>
        <hr className="cl-rule-soft" />
        <div className="cl-mono mt-1 text-[11px]">
          <label style={{ display: "block", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={orphansVisible}
              onChange={(e) => setOrphansVisible(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            orphans visible
          </label>
          <label style={{ display: "block", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={hideDaily}
              onChange={(e) => setHideDaily(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            daily nodes hidden
          </label>
          <div style={{ marginTop: 4 }}>
            depth ·{" "}
            {[1, 2, null].map((d) => (
              <button
                key={String(d)}
                type="button"
                onClick={() => setDepth(d)}
                style={{
                  marginRight: 4,
                  padding: "0 4px",
                  background: depth === d ? "var(--accent)" : "transparent",
                  color: depth === d ? "var(--paper)" : "var(--ink)",
                  border: "1px solid var(--rule-soft)",
                  cursor: anchorId || d == null ? "pointer" : "not-allowed",
                  opacity: d != null && !anchorId ? 0.4 : 1,
                }}
                disabled={d != null && !anchorId}
                title={
                  d != null && !anchorId
                    ? "open a page tab to use depth"
                    : undefined
                }
              >
                {d ?? "all"}
              </button>
            ))}
          </div>
        </div>

        <div className="cl-cap mb-1 mt-4 text-[9px]">§ Legend</div>
        <hr className="cl-rule-soft" />
        <div className="cl-mono mt-1 flex flex-col gap-[3px] text-[10px] text-ink-mute">
          {(
            [
              ["▪", "PROJECT", "project"],
              ["▲", "TODO", "todo"],
              ["◦", "JOURNAL", "journal"],
              ["•", "NOTE", "other"],
            ] as [string, Kind, string][]
          ).map(([glyph, kind, label]) => (
            <div key={kind} className="flex items-center gap-2">
              <span style={{ color: kindColorVar(kind) }}>{glyph}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

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
