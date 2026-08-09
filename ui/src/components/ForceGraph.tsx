import { drag } from "d3-drag";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "#/api/types";
import { type Kind, kindColorVar, resolveKindFromPath } from "#/lib/kind";

/** Kind-coded node glyph: square=PROJECT, triangle=TODO, ring=JOURNAL, dot=other. */
function nodeShape(kind: Kind): { d: string; filled: boolean } {
  const s = 6;
  if (kind === "PROJECT")
    return { d: `M${-s} ${-s}h${2 * s}v${2 * s}h${-2 * s}Z`, filled: true };
  if (kind === "TODO")
    return { d: `M0 ${-s}L${s} ${s}L${-s} ${s}Z`, filled: true };
  if (kind === "JOURNAL")
    return {
      d: `M${-s} 0a${s} ${s} 0 1 0 ${2 * s} 0a${s} ${s} 0 1 0 ${-2 * s} 0`,
      filled: false,
    };
  const r = 4;
  return {
    d: `M${-r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`,
    filled: true,
  };
}

interface SimNode extends SimulationNodeDatum, GraphNode {}

interface ForceGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (node: GraphNode) => void;
}

export function ForceGraph({ nodes, edges, onNodeClick }: ForceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewport = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      viewportRef.current = { width, height };
      setViewport((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };

    const bounds = container.getBoundingClientRect();
    updateViewport(bounds.width, bounds.height);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      updateViewport(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const initGraph = useCallback(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return undefined;

    const bounds = containerRef.current?.getBoundingClientRect();
    const width =
      viewportRef.current.width || bounds?.width || svg.clientWidth || 1;
    const height =
      viewportRef.current.height || bounds?.height || svg.clientHeight || 1;

    // Build simulation data (copies to avoid mutating props)
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }));
    const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks = edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({
        source: nodeMap.get(e.source)!,
        target: nodeMap.get(e.target)!,
        kind: e.kind,
      }));

    // Stop any prior simulation
    simRef.current?.stop();

    const sim = forceSimulation(simNodes)
      .force(
        "link",
        forceLink(simLinks)
          .id((d) => (d as SimNode).id)
          .distance(80),
      )
      .force("charge", forceManyBody().strength(-200))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide(20));

    simRef.current = sim;

    const svgSel = select(svg);
    const gSel = select(g);

    // Zoom
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        gSel.attr("transform", event.transform);
        const targetSize = 44 / event.transform.k;
        gSel
          .selectAll<SVGRectElement, SimNode>(".node-hit-target")
          .attr("x", -targetSize / 2)
          .attr("y", -targetSize / 2)
          .attr("width", targetSize)
          .attr("height", targetSize);
      });
    svgSel.call(zoomBehavior).call(zoomBehavior.transform, zoomIdentity);

    // Clear existing elements
    gSel.selectAll("*").remove();

    // Links
    const linkSel = gSel
      .selectAll("line")
      .data(simLinks)
      .join("line")
      .attr("class", "stroke-accent")
      .attr("stroke-width", 1)
      .attr("stroke-opacity", 0.3);

    // Nodes — a transparent 44×44 interaction surface owns click/drag while
    // the visible kind glyph remains pointer-transparent.
    const nodeSel = gSel
      .selectAll<SVGGElement, SimNode>("g.node")
      .data(simNodes)
      .join("g")
      .attr("class", "node cursor-pointer");

    nodeSel
      .append("rect")
      .attr("class", "node-hit-target")
      .attr("x", -22)
      .attr("y", -22)
      .attr("width", 44)
      .attr("height", 44)
      .attr("fill", "transparent")
      .attr("pointer-events", "all")
      .on("click", (event, d) => {
        event.stopPropagation();
        onNodeClick?.(d);
      });

    nodeSel
      .append("path")
      .attr("class", "node-glyph")
      .attr("pointer-events", "none")
      .attr("d", (d) => nodeShape(resolveKindFromPath(d.path)).d)
      .attr("fill", (d) => {
        const k = resolveKindFromPath(d.path);
        return nodeShape(k).filled ? kindColorVar(k) : "none";
      })
      .attr("stroke", (d) => kindColorVar(resolveKindFromPath(d.path)))
      .attr("stroke-width", (d) =>
        nodeShape(resolveKindFromPath(d.path)).filled ? 0 : 1.5,
      );

    // Labels
    const labelSel = gSel
      .selectAll<SVGTextElement, SimNode>("text")
      .data(simNodes)
      .join("text")
      .text((d) => d.title || d.path)
      .attr("class", "cl-mono fill-muted-foreground text-[9px]")
      .attr("pointer-events", "none")
      .attr("dx", 10)
      .attr("dy", 4);

    // Drag
    const dragBehavior = drag<SVGGElement, SimNode>()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = event.x as number | null;
        d.fy = event.y as number | null;
      })
      .on("drag", (event, d) => {
        d.fx = event.x as number | null;
        d.fy = event.y as number | null;
      })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    nodeSel.call(dragBehavior);

    sim.on("tick", () => {
      linkSel
        .attr("x1", (d) => (d.source as SimNode).x!)
        .attr("y1", (d) => (d.source as SimNode).y!)
        .attr("x2", (d) => (d.target as SimNode).x!)
        .attr("y2", (d) => (d.target as SimNode).y!);

      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);

      labelSel.attr("x", (d) => d.x!).attr("y", (d) => d.y!);
    });

    return () => {
      sim.stop();
    };
  }, [nodes, edges, onNodeClick]);

  useEffect(() => {
    return initGraph();
  }, [initGraph]);

  useEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const simulation = simRef.current;
    if (!simulation) return;
    simulation.force(
      "center",
      forceCenter(viewport.width / 2, viewport.height / 2),
    );
    simulation.alpha(0.3).restart();
  }, [viewport.height, viewport.width]);

  const viewBoxWidth = Math.max(viewport.width, 1);
  const viewBoxHeight = Math.max(viewport.height, 1);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden bg-background"
    >
      <svg
        ref={svgRef}
        role="img"
        aria-label="Constellation graph"
        className="block h-full w-full touch-none bg-background"
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      >
        <g ref={gRef} />
      </svg>
    </div>
  );
}
