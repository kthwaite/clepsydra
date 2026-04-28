import { useGraph } from "#/api/index";
import type { GraphNode } from "#/api/types";
import { ASCII_COMPASS } from "#/components/codex/ascii";
import { Sheaf } from "#/components/codex/Sheaf";
import { ForceGraph } from "#/components/ForceGraph";
import { useOpenTab } from "#/hooks/useOpenTab";

export function Constellation({ tabId }: { tabId: string }) {
  const { data: graph, isLoading } = useGraph();
  const openTab = useOpenTab();

  if (isLoading || !graph) {
    return <div className="cl-marg p-6">… plotting the constellation …</div>;
  }
  if (graph.nodes.length === 0) {
    return <div className="cl-marg p-6">⁂ no folios to plot. Inscribe a folio first.</div>;
  }

  const handle = (node: GraphNode) => openTab("page", node.path, node.title || node.path);
  const orphans = graph.nodes.filter(
    (n) => !graph.edges.some((e) => e.source === n.id || e.target === n.id),
  );
  const degrees = countDegrees(graph.edges);
  const hubs = [...graph.nodes]
    .map((n) => ({ ...n, degree: degrees.get(n.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 6);

  return (
    <div className="flex h-full flex-col">
      <Sheaf activeTabId={tabId} />
      <div className="grid h-full grid-cols-[1fr_240px] gap-[18px] px-5 py-[14px]">
        {/* CHART */}
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 flex items-baseline justify-between">
            <div>
              <div className="cl-cap cl-cap-wide text-[14px]">CONSTELLATION</div>
              <div className="cl-marg">— a map of one's mind, drawn from the connexions —</div>
            </div>
            <div className="cl-mono text-[10px] text-ink-mute">
              fig. v · {graph.nodes.length} nodes · {graph.edges.length} vertices
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
            <div className="cl-mono absolute right-4 top-2 text-[9px]">N ↑ · scale 1:1</div>

            <div className="absolute bottom-2 right-4">
              <pre className="cl-ascii cl-ascii-faint text-[6px]">{ASCII_COMPASS}</pre>
            </div>

            <ForceGraph nodes={graph.nodes} edges={graph.edges} onNodeClick={handle} />
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
            {hubs.length === 0 && <p className="cl-marg m-0">No connexions yet.</p>}
          </div>

          <div className="cl-cap mb-1 mt-4 text-[9px]">§ Orphans · {orphans.length}</div>
          <hr className="cl-rule-soft" />
          {orphans.length === 0 ? (
            <p className="cl-marg mt-1">All folios connect to the body of work.</p>
          ) : (
            <p className="cl-marg mt-1">
              {orphans.length} folios stand alone, with no connexion to the body of work — reader,
              attend to them, or release them.
            </p>
          )}

          <div className="cl-cap mb-1 mt-4 text-[9px]">§ Filters</div>
          <hr className="cl-rule-soft" />
          <div className="cl-mono mt-1 text-[11px]">
            <div>◉ subjects · all</div>
            <div>○ depth · 2</div>
            <div>◉ orphans visible</div>
            <div>○ daily nodes hidden</div>
            <div>○ time-window · all</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function countDegrees(edges: { source: string; target: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) {
    m.set(e.source, (m.get(e.source) ?? 0) + 1);
    m.set(e.target, (m.get(e.target) ?? 0) + 1);
  }
  return m;
}
