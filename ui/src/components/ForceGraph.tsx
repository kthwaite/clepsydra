import { type D3DragEvent, drag, dragEnable } from "d3-drag";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { type ZoomBehavior, zoom, zoomIdentity, zoomTransform } from "d3-zoom";
import { useEffect, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "#/api/types";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { type Kind, kindColorVar } from "#/lib/kind";

/** Kind-coded node glyph: square=PROJECT, triangle=TODO/TASK, ring=JOURNAL,
 *  dashed ring=AI_JOURNAL, dot=other. */
function nodeShape(kind: Kind): {
  d: string;
  filled: boolean;
  dashed?: boolean;
} {
  const s = 6;
  if (kind === "PROJECT")
    return { d: `M${-s} ${-s}h${2 * s}v${2 * s}h${-2 * s}Z`, filled: true };
  if (kind === "TODO" || kind === "TASK")
    return { d: `M0 ${-s}L${s} ${s}L${-s} ${s}Z`, filled: true };
  if (kind === "JOURNAL")
    return {
      d: `M${-s} 0a${s} ${s} 0 1 0 ${2 * s} 0a${s} ${s} 0 1 0 ${-2 * s} 0`,
      filled: false,
    };
  if (kind === "AI_JOURNAL")
    return {
      d: `M${-s} 0a${s} ${s} 0 1 0 ${2 * s} 0a${s} ${s} 0 1 0 ${-2 * s} 0`,
      filled: false,
      dashed: true,
    };
  const r = 4;
  return {
    d: `M${-r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`,
    filled: true,
  };
}

/** The glyph used for a kind, sized for the rail legend. */
export function KindGlyph({ kind }: { kind: Kind }) {
  const shape = nodeShape(kind);
  const color = kindColorVar(kind);
  return (
    <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
      <path
        d={shape.d}
        style={{
          fill: shape.filled ? color : "none",
          stroke: color,
          strokeWidth: shape.filled ? 0 : 1.5,
        }}
        strokeDasharray={shape.dashed ? "2,2" : undefined}
      />
    </svg>
  );
}

interface SimNode extends SimulationNodeDatum, GraphNode {
  x: number;
  y: number;
  degree: number;
}

interface SimLink {
  source: SimNode;
  target: SimNode;
  kind: GraphEdge["kind"];
}

interface ForceGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groupBy?: "none" | "kind" | "folder";
  focusedIds?: ReadonlySet<string> | null;
  selectedNodeId?: string | null;
  onNodeSelect?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null) => void;
}

export function ForceGraph({
  nodes,
  edges,
  groupBy = "none",
  focusedIds = null,
  selectedNodeId = null,
  onNodeSelect,
  onNodeHover,
}: ForceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const callbacks = useRef({ onNodeSelect, onNodeHover });
  const positions = useRef(new Map<string, SimNode>());
  const disposeLayout = useRef<(() => void) | null>(null);
  const paintFocus = useRef<(() => void) | null>(null);
  const paintLabels = useRef<(() => void) | null>(null);
  const zoomBehavior = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(
    null,
  );
  const userViewport = useRef(false);
  const focus = useRef({ focusedIds, selectedNodeId });
  const previous = useRef<{
    nodes: GraphNode[];
    edges: GraphEdge[];
    groupBy: ForceGraphProps["groupBy"];
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    callbacks.current = { onNodeSelect, onNodeHover };
    focus.current = { focusedIds, selectedNodeId };
    paintFocus.current?.();
  }, [onNodeSelect, onNodeHover, focusedIds, selectedNodeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      setViewport((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    const bounds = container.getBoundingClientRect();
    update(bounds.width, bounds.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Zoom owns only the viewport, never the simulation or focus state.
  useEffect(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;
    const surface = select(svg);
    const content = select(g);
    let panning = false;
    const behavior = zoom<SVGSVGElement, unknown>()
      .extent((): [[number, number], [number, number]] => {
        const bounds = svg.getBoundingClientRect();
        return [
          [0, 0],
          [bounds.width || 1, bounds.height || 1],
        ];
      })
      .scaleExtent([0.1, 4])
      .on("start", (event) => {
        panning = event.sourceEvent?.type === "mousedown";
      })
      .on("end", () => {
        panning = false;
      })
      .on("zoom", (event) => {
        if (event.sourceEvent) userViewport.current = true;
        content.attr("transform", event.transform);
        const size = 44 / event.transform.k;
        content
          .selectAll(".node-hit-target")
          .attr("x", -size / 2)
          .attr("y", -size / 2)
          .attr("width", size)
          .attr("height", size);
        paintLabels.current?.();
      });
    zoomBehavior.current = behavior;
    surface.call(behavior).on("dblclick.zoom", null);
    return () => {
      surface.on(".zoom", null);
      if (panning) {
        select(window).on(".zoom", null);
        dragEnable(window);
      }
      zoomBehavior.current = null;
      disposeLayout.current?.();
      disposeLayout.current = null;
      previous.current = null;
    };
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;
    const width = viewport.width || 1;
    const height = viewport.height || 1;
    const old = previous.current;
    // Callers may rebuild their arrays on focus updates. Equal graph data is
    // still the same layout: don't cancel its run or reset its coordinates.
    if (
      old &&
      old.groupBy === groupBy &&
      old.width === width &&
      old.height === height &&
      old.nodes.length === nodes.length &&
      old.edges.length === edges.length &&
      nodes.every((node, index) => {
        const before = old.nodes[index];
        return (
          before.id === node.id &&
          before.path === node.path &&
          before.title === node.title &&
          before.kind === node.kind
        );
      }) &&
      edges.every((edge, index) => {
        const before = old.edges[index];
        return (
          before.source === edge.source &&
          before.target === edge.target &&
          before.kind === edge.kind
        );
      })
    )
      return;

    disposeLayout.current?.();
    previous.current = { nodes, edges, groupBy, width, height };
    const simNodes: SimNode[] = nodes.map((node, index) => {
      const saved = positions.current.get(node.id);
      const radius = 44 * Math.sqrt(index + 0.5);
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      return {
        ...node,
        x: saved?.x ?? width / 2 + Math.cos(angle) * radius,
        y: saved?.y ?? height / 2 + Math.sin(angle) * radius,
        degree: 0,
      };
    });
    const nodeMap = new Map(simNodes.map((node) => [node.id, node]));
    positions.current = nodeMap;
    const simLinks: SimLink[] = [];
    for (const edge of edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      source.degree++;
      target.degree++;
      simLinks.push({ source, target, kind: edge.kind });
    }

    const sim = forceSimulation(simNodes)
      .stop()
      .alphaDecay(1 - 0.001 ** (1 / 180))
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((node) => node.id)
          .distance(
            (link) =>
              105 +
              24 * Math.sqrt(Math.max(link.source.degree, link.target.degree)),
          ),
      )
      .force(
        "charge",
        forceManyBody<SimNode>()
          .strength((node) => -220 - 110 * Math.sqrt(node.degree))
          .distanceMax(Math.max(600, Math.sqrt(nodes.length) * 100)),
      )
      .force("center", forceCenter(width / 2, height / 2))
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius(
            (node) =>
              32 +
              Math.min(24, (node.title || node.path).length) +
              2 * Math.sqrt(node.degree),
          )
          .iterations(2),
      );

    if (groupBy !== "none") {
      const key = (node: SimNode) => {
        if (groupBy === "kind") return node.kind;
        const separator = node.path.indexOf("/");
        return separator < 0 ? "/" : node.path.slice(0, separator);
      };
      const groups = [...new Set(simNodes.map(key))].sort();
      const radius =
        groups.length > 1 ? Math.max(180, Math.sqrt(nodes.length) * 42) : 0;
      const centers = new Map(
        groups.map((group, index) => {
          const angle = (index / groups.length) * Math.PI * 2;
          return [
            group,
            {
              x: width / 2 + Math.cos(angle) * radius,
              y: height / 2 + Math.sin(angle) * radius,
            },
          ];
        }),
      );
      sim
        .force(
          "group-x",
          forceX<SimNode>(
            (node) => centers.get(key(node))?.x ?? width / 2,
          ).strength(0.12),
        )
        .force(
          "group-y",
          forceY<SimNode>(
            (node) => centers.get(key(node))?.y ?? height / 2,
          ).strength(0.12),
        );
    }

    const content = select(g);
    const links = content
      .selectAll<SVGLineElement, SimLink>("line")
      .data(
        simLinks,
        (link) => `${link.source.id}:${link.target.id}:${link.kind}`,
      )
      .join("line")
      .attr("data-source", (link) => link.source.id)
      .attr("data-target", (link) => link.target.id)
      .attr("stroke", "var(--accent)")
      .attr("stroke-width", 1)
      .attr("pointer-events", "none");
    // Keep edges behind both existing and newly inserted nodes.
    links.lower();
    let activeNodeId: string | null = null;
    const nodeSelection = content
      .selectAll<SVGGElement, SimNode>("g.node")
      .data(simNodes, (node) => node.id)
      .join((enter) => {
        const node = enter
          .append("g")
          .attr("class", `node cursor-pointer ${FOCUS_RING_NATIVE}`);
        node
          .append("rect")
          .attr("class", "node-hit-target")
          .attr("fill", "transparent")
          .attr("pointer-events", "all");
        node
          .append("circle")
          .attr("class", "node-selection")
          .attr("r", 11)
          .attr("fill", "none")
          .attr("stroke", "var(--accent)")
          .attr("stroke-width", 2)
          .attr("pointer-events", "none");
        node
          .append("circle")
          .attr("class", "node-keyboard-focus")
          .attr("r", 16)
          .attr("fill", "none")
          .attr("opacity", 0)
          .attr("stroke", "var(--accent)")
          .attr("stroke-width", 2)
          .attr("stroke-dasharray", "3,3")
          .attr("pointer-events", "none");
        node
          .append("path")
          .attr("class", "node-glyph")
          .attr("pointer-events", "none");
        node
          .append("text")
          .attr("class", "font-sans")
          .attr("font-size", 12)
          .attr("pointer-events", "none")
          .attr("dx", 12)
          .attr("dy", 4)
          .attr("fill", "var(--ink-2)");
        node.append("title");
        return node;
      })
      .attr("data-node-id", (node) => node.id)
      .attr("role", "button")
      .attr("tabindex", 0)
      .attr("aria-label", (node) => node.title || node.path)
      .on("click", (event, node) => {
        event.stopPropagation();
        callbacks.current.onNodeSelect?.(node);
      })
      .on("keydown", (event: KeyboardEvent, node) => {
        if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
          event.preventDefault();
          event.stopPropagation();
          callbacks.current.onNodeSelect?.(node);
        }
      })
      .on("pointerenter", (event: PointerEvent, node) => {
        if (event.pointerType === "touch") return;
        activeNodeId = node.id;
        paintLabels.current?.();
        callbacks.current.onNodeHover?.(node);
      })
      .on("pointerleave", (event: PointerEvent) => {
        if (event.pointerType === "touch") return;
        activeNodeId = null;
        paintLabels.current?.();
        callbacks.current.onNodeHover?.(null);
      })
      .on("focus", function (_event, node) {
        select(this).select(".node-keyboard-focus").attr("opacity", 1);
        activeNodeId = node.id;
        paintLabels.current?.();
        callbacks.current.onNodeHover?.(node);
      })
      .on("blur", function () {
        select(this).select(".node-keyboard-focus").attr("opacity", 0);
        activeNodeId = null;
        paintLabels.current?.();
        callbacks.current.onNodeHover?.(null);
      });
    const size = 44 / zoomTransform(svg).k;
    nodeSelection
      .select("rect")
      .attr("x", -size / 2)
      .attr("y", -size / 2)
      .attr("width", size)
      .attr("height", size);
    nodeSelection
      .select("path")
      .attr("d", (node) => nodeShape(node.kind).d)
      .attr("fill", (node) =>
        nodeShape(node.kind).filled ? kindColorVar(node.kind) : "none",
      )
      .attr("stroke", (node) => kindColorVar(node.kind))
      .attr("stroke-width", (node) => (nodeShape(node.kind).filled ? 0 : 1.5))
      .attr("stroke-dasharray", (node) =>
        nodeShape(node.kind).dashed ? "2,2" : null,
      );
    nodeSelection.select("text").text((node) => {
      const title = node.title || node.path;
      return title.length > 34 ? `${title.slice(0, 33)}…` : title;
    });
    nodeSelection.select("title").text((node) => node.title || node.path);
    paintLabels.current = () => {
      const scale = zoomTransform(svg).k;
      // Keep overview glyphs visible after fitting a large vault. Interaction
      // targets remain 44 screen pixels; selection rings must remain legible too.
      nodeSelection
        .select(".node-glyph")
        .attr("transform", `scale(${Math.max(1, 0.65 / scale)})`);
      nodeSelection
        .selectAll(".node-selection, .node-keyboard-focus")
        .attr("transform", `scale(${Math.max(1, 1 / scale)})`);
      const showAll = scale >= 0.8;
      nodeSelection
        .select("text")
        .attr("visibility", (node) =>
          showAll ||
          node.id === activeNodeId ||
          node.id === focus.current.selectedNodeId
            ? "visible"
            : "hidden",
        )
        .attr("font-size", Math.max(12, 12 / scale))
        .attr("dx", Math.max(12, 12 / scale))
        .attr("dy", Math.max(4, 4 / scale));
    };

    paintFocus.current = () => {
      const { focusedIds: ids, selectedNodeId: selected } = focus.current;
      nodeSelection
        .attr("opacity", (node) =>
          !ids || ids.has(node.id) || node.id === selected ? 1 : 0.18,
        )
        .attr("aria-pressed", (node) => String(node.id === selected));
      nodeSelection
        .select(".node-selection")
        .attr("opacity", (node) => (node.id === selected ? 1 : 0));
      links.attr("stroke-opacity", (link) =>
        !ids || (ids.has(link.source.id) && ids.has(link.target.id))
          ? 0.4
          : 0.06,
      );
      paintLabels.current?.();
    };
    paintFocus.current();

    const draw = () => {
      links
        .attr("x1", (link) => link.source.x)
        .attr("y1", (link) => link.source.y)
        .attr("x2", (link) => link.target.x)
        .attr("y2", (link) => link.target.y);
      nodeSelection.attr(
        "transform",
        (node) => `translate(${node.x},${node.y})`,
      );
    };
    draw();
    let fitAfterRun = true;
    const fitViewport = () => {
      const behavior = zoomBehavior.current;
      if (
        !behavior ||
        userViewport.current ||
        !simNodes.length ||
        width <= 1 ||
        height <= 1
      )
        return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const node of simNodes) {
        minX = Math.min(minX, node.x - 24);
        maxX = Math.max(maxX, node.x + 24);
        minY = Math.min(minY, node.y - 24);
        maxY = Math.max(maxY, node.y + 24);
      }
      const labelSpace = nodes.length < 40 ? 220 : 0;
      maxX += labelSpace;
      const scale = Math.min(
        1.25,
        Math.max(1, width - 64) / (maxX - minX),
        Math.max(1, height - 64) / (maxY - minY),
      );
      behavior.scaleExtent([Math.min(0.1, scale), 4]);
      select(svg).call(
        behavior.transform,
        zoomIdentity
          .translate(
            width / 2 - ((minX + maxX) / 2) * scale,
            height / 2 - ((minY + maxY) / 2) * scale,
          )
          .scale(scale),
      );
    };
    fitViewport();
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let reducedMotion = motion?.matches ?? false;
    const onMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
    };
    motion?.addEventListener?.("change", onMotionChange);
    let frame = 0;
    let remaining = 0;
    // Manual bounded frames avoid D3's unbounded alphaTarget drag loop.
    // Even reduced-motion layouts yield between batches, painting only once.
    const tick = () => {
      const start = performance.now();
      let batch = 0;
      do {
        sim.tick();
        remaining--;
        batch++;
      } while (remaining > 0 && batch < 4 && performance.now() - start < 8);
      if (!reducedMotion || remaining <= 0) draw();
      if (remaining > 0) frame = requestAnimationFrame(tick);
      else {
        frame = 0;
        if (fitAfterRun) fitViewport();
        svg.setAttribute("aria-busy", "false");
      }
    };
    const run = (ticks: number) => {
      cancelAnimationFrame(frame);
      remaining = ticks;
      sim.alpha(0.8);
      svg.setAttribute("aria-busy", ticks > 0 ? "true" : "false");
      if (ticks > 0) frame = requestAnimationFrame(tick);
    };
    let dragging = false;
    nodeSelection.call(
      drag<SVGGElement, SimNode>().on("start", (event, node) => {
        dragging = true;
        let moved = false;
        event.on(
          "drag",
          (movement: D3DragEvent<SVGGElement, SimNode, SimNode>) => {
            if (!moved) {
              moved = true;
              fitAfterRun = false;
              run(60);
            }
            node.x = node.fx = movement.x;
            node.y = node.fy = movement.y;
            draw();
          },
        );
        event.on("end", (end: D3DragEvent<SVGGElement, SimNode, SimNode>) => {
          dragging = end.active > 0;
          if (moved) {
            node.fx = null;
            node.fy = null;
            run(60);
          }
        });
      }),
    );
    run(nodes.length ? 180 : 0);
    disposeLayout.current = () => {
      cancelAnimationFrame(frame);
      sim.stop();
      motion?.removeEventListener?.("change", onMotionChange);
      nodeSelection.on(".drag", null);
      if (dragging) {
        select(window).on(".drag", null);
        dragEnable(window);
      }
      paintFocus.current = null;
      paintLabels.current = null;
    };
  }, [nodes, edges, groupBy, viewport.width, viewport.height]);

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden">
      <svg
        ref={svgRef}
        aria-label="Constellation graph"
        className="block h-full w-full touch-none"
        viewBox={`0 0 ${Math.max(viewport.width, 1)} ${Math.max(viewport.height, 1)}`}
      >
        <g ref={gRef} />
      </svg>
    </div>
  );
}
