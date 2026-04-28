# UI Features: Search, Graph, Folder Tree — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add three interactive UI features — a search command palette, an SVG force-directed graph visualization, and a folder tree sidebar using headless-tree — replacing the flat page list.

**Architecture:** The search palette is a modal overlay (Cmd+K) using the existing `useSearch` hook with debounced input. The graph visualization renders to an SVG canvas using d3-force for layout simulation, driven by `useGraph`. The folder tree replaces `PageList` with `@headless-tree/react`, building a virtual folder hierarchy from the flat `PageSummary[]` list.

**Tech Stack:** React 19, TanStack Router/Query, `d3-force` + `d3-drag` + `d3-zoom` (SVG graph), `@headless-tree/core` + `@headless-tree/react` (folder tree), `lucide-react` (icons), Tailwind v4

---

## Task 1: Install d3 dependencies

**Files:**
- Modify: `ui/package.json`

**Step 1: Install packages**

```bash
cd ui
bun add d3-force d3-drag d3-zoom d3-selection
bun add -d @types/d3-force @types/d3-drag @types/d3-zoom @types/d3-selection
```

Only these four d3 modules — not all of d3. We use SVG elements directly (no d3-dom manipulation needed for rendering).

**Step 2: Verify build**

```bash
cd ui && bun run typecheck
```

**Step 3: Commit**

```bash
git add ui/package.json ui/bun.lock
git commit -m "chore(ui): add d3-force graph layout dependencies"
```

---

## Task 2: Search command palette

A modal overlay triggered by Cmd+K (or Ctrl+K). Debounced text input queries the search API. Results show page title, path, and snippet. Selecting a result navigates to the page.

**Files:**
- Create: `ui/src/components/SearchPalette.tsx`
- Create: `ui/src/hooks/useDebounce.ts`
- Modify: `ui/src/components/AppLayout.tsx`

**Step 1: Create debounce hook**

Create `ui/src/hooks/useDebounce.ts`:

```typescript
import { useEffect, useState } from "react";

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
```

**Step 2: Create SearchPalette component**

Create `ui/src/components/SearchPalette.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useSearch } from "#/api/index";
import { useDebounce } from "#/hooks/useDebounce";

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 200);
  const { data: results } = useSearch(debouncedQuery, 10);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Cmd+K / Ctrl+K to toggle
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  function selectResult(path: string) {
    setOpen(false);
    navigate({ to: "/pages/$", params: { _splat: path } });
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (!results || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectResult(results[selectedIndex].path);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search pages..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            Esc
          </kbd>
        </div>

        {debouncedQuery && results && results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto">
            {results.map((r, i) => (
              <li key={r.page_id}>
                <button
                  type="button"
                  className={`block w-full px-4 py-2 text-left text-sm ${
                    i === selectedIndex ? "bg-accent" : "hover:bg-accent"
                  }`}
                  onClick={() => selectResult(r.path)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <span className="font-medium">{r.title || r.path}</span>
                  {r.title && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.path}
                    </span>
                  )}
                  {r.snippet && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {r.snippet.replace(/<\/?mark>/g, "")}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {debouncedQuery && results && results.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No results for &ldquo;{debouncedQuery}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}
```

Design notes:
- No border-radius (brutalist)
- Hard shadow on the modal
- Keyboard navigation: Arrow Up/Down to move, Enter to select, Esc to close
- Snippet text is stripped of HTML `<mark>` tags for safe rendering (no dangerouslySetInnerHTML)
- Backdrop click to dismiss

**Step 3: Wire into AppLayout**

In `ui/src/components/AppLayout.tsx`, import and render `<SearchPalette />` alongside the layout. It's a portal-like fixed overlay — just place it at the top level:

```tsx
import { SearchPalette } from "#/components/SearchPalette";
import { Search } from "lucide-react";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <SearchPalette />
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-end gap-3 border-b border-border px-4 py-2">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="flex items-center gap-2 border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            <Search className="h-3 w-3" />
            Search
            <kbd className="border border-border px-1 py-0.5 text-[10px]">⌘K</kbd>
          </button>
          <SyncIndicator />
          <ThemeToggle className="inline-flex h-8 w-8 items-center justify-center border border-border bg-background text-foreground" />
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
```

**Step 4: Verify typecheck**

```bash
cd ui && bun run typecheck
```

**Step 5: Commit**

```bash
git add ui/src/components/SearchPalette.tsx ui/src/hooks/useDebounce.ts ui/src/components/AppLayout.tsx
git commit -m "feat(ui): add search command palette with Cmd+K shortcut"
```

---

## Task 3: Graph visualization route

A full-page force-directed graph showing pages as nodes and links as edges. Uses SVG rendering with d3-force for physics simulation, d3-zoom for pan/zoom, and d3-drag for interactive node dragging. Clicking a node navigates to the page.

**Files:**
- Create: `ui/src/components/ForceGraph.tsx`
- Create: `ui/src/routes/graph.tsx`

**Step 1: Create ForceGraph component**

Create `ui/src/components/ForceGraph.tsx`:

```tsx
import { useCallback, useEffect, useRef } from "react";
import {
  type Simulation,
  type SimulationNodeDatum,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";
import { drag } from "d3-drag";
import { zoom, zoomIdentity } from "d3-zoom";
import { select } from "d3-selection";
import type { GraphEdge, GraphNode } from "#/api/types";

interface SimNode extends SimulationNodeDatum, GraphNode {}

interface ForceGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (node: GraphNode) => void;
}

export function ForceGraph({ nodes, edges, onNodeClick }: ForceGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);

  const initGraph = useCallback(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;

    const width = svg.clientWidth;
    const height = svg.clientHeight;

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
          .id((d: SimNode) => d.id)
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
      });
    svgSel.call(zoomBehavior).call(zoomBehavior.transform, zoomIdentity);

    // Clear existing elements
    gSel.selectAll("*").remove();

    // Links
    const linkSel = gSel
      .selectAll("line")
      .data(simLinks)
      .join("line")
      .attr("class", "stroke-border")
      .attr("stroke-width", 1);

    // Nodes
    const nodeSel = gSel
      .selectAll<SVGCircleElement, SimNode>("circle")
      .data(simNodes)
      .join("circle")
      .attr("r", 6)
      .attr("class", "fill-foreground cursor-pointer")
      .on("click", (_event, d) => onNodeClick?.(d));

    // Labels
    const labelSel = gSel
      .selectAll<SVGTextElement, SimNode>("text")
      .data(simNodes)
      .join("text")
      .text((d) => d.title || d.path)
      .attr("class", "fill-muted-foreground text-[10px]")
      .attr("dx", 10)
      .attr("dy", 4);

    // Drag
    const dragBehavior = drag<SVGCircleElement, SimNode>()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
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

      nodeSel.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);

      labelSel.attr("x", (d) => d.x!).attr("y", (d) => d.y!);
    });

    return () => sim.stop();
  }, [nodes, edges, onNodeClick]);

  useEffect(() => {
    const cleanup = initGraph();
    return () => cleanup?.();
  }, [initGraph]);

  return (
    <svg ref={svgRef} className="h-full w-full bg-background">
      <g ref={gRef} />
    </svg>
  );
}
```

Design notes:
- SVG rendering (not canvas) — clean, scalable, easy to style
- d3-force handles physics simulation (repulsion, link springs, centering, collision)
- d3-zoom for pan/zoom on the SVG container
- d3-drag for interactive node repositioning
- Clicking a node triggers `onNodeClick` (used for navigation)
- Tailwind color tokens applied via class attributes on SVG elements
- No border-radius (circles are inherently round — that's geometry, not style)

**Step 2: Create graph route**

Create `ui/src/routes/graph.tsx`:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGraph } from "#/api/index";
import { ForceGraph } from "#/components/ForceGraph";
import type { GraphNode } from "#/api/types";

export const Route = createFileRoute("/graph")({
  component: GraphView,
});

function GraphView() {
  const { data: graph, isLoading } = useGraph();
  const navigate = useNavigate();

  function handleNodeClick(node: GraphNode) {
    navigate({ to: "/pages/$", params: { _splat: node.path } });
  }

  if (isLoading || !graph) {
    return <div className="p-8 text-muted-foreground">Loading graph...</div>;
  }

  if (graph.nodes.length === 0) {
    return <div className="p-8 text-muted-foreground">No pages to graph.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-sm font-bold uppercase tracking-widest">
          Graph ({graph.nodes.length} nodes, {graph.edges.length} edges)
        </h1>
      </div>
      <div className="flex-1">
        <ForceGraph
          nodes={graph.nodes}
          edges={graph.edges}
          onNodeClick={handleNodeClick}
        />
      </div>
    </div>
  );
}
```

**Step 3: Add graph link to sidebar**

In `ui/src/components/Sidebar.tsx`, add a navigation tab bar between the header and the nav section:

```tsx
// After the header div with "clepsydra", before <nav>:
<div className="flex border-b border-border">
  <Link
    to="/"
    className="flex-1 px-3 py-1.5 text-center text-xs uppercase tracking-wider hover:bg-accent"
    activeProps={{ className: "bg-accent font-bold" }}
    activeOptions={{ exact: true }}
  >
    Pages
  </Link>
  <Link
    to="/graph"
    className="flex-1 border-l border-border px-3 py-1.5 text-center text-xs uppercase tracking-wider hover:bg-accent"
    activeProps={{ className: "bg-accent font-bold" }}
  >
    Graph
  </Link>
</div>
```

**Step 4: Verify typecheck**

```bash
cd ui && bun run typecheck
```

Note: TanStack Router's Vite plugin will auto-regenerate `routeTree.gen.ts` when the new route file is detected. Include it in the commit if changed.

**Step 5: Commit**

```bash
git add ui/src/components/ForceGraph.tsx ui/src/routes/graph.tsx ui/src/components/Sidebar.tsx ui/src/routeTree.gen.ts
git commit -m "feat(ui): add force-directed graph visualization with pan/zoom/drag"
```

---

## Task 4: Folder tree — data transformation

Build the data layer that transforms a flat `PageSummary[]` list into a tree structure for headless-tree.

**Files:**
- Create: `ui/src/lib/buildPageTree.ts`

**Step 1: Create tree builder**

The flat page list has paths like `library/papers/smith2024.md`, `notes/daily.md`, `readme.md`. We need to build a tree where folders are virtual nodes (not real pages) and leaves are actual pages.

Create `ui/src/lib/buildPageTree.ts`:

```typescript
import type { PageSummary } from "#/api/types";

export interface TreeNode {
  id: string;
  name: string;
  isFolder: boolean;
  children: string[];
  page: PageSummary | null;
}

export type TreeData = Record<string, TreeNode>;

/**
 * Build a virtual folder tree from a flat page list.
 *
 * Each page path like "library/papers/foo.md" produces:
 * - folder "root" with child "library"
 * - folder "library" with child "library/papers"
 * - folder "library/papers" with child "library/papers/foo.md"
 * - leaf "library/papers/foo.md" pointing to the page
 */
export function buildPageTree(pages: PageSummary[]): TreeData {
  const data: TreeData = {
    root: { id: "root", name: "root", isFolder: true, children: [], page: null },
  };

  for (const page of pages) {
    const parts = page.path.split("/");
    let parentId = "root";

    // Create intermediate folder nodes
    for (let i = 0; i < parts.length - 1; i++) {
      const folderId = parts.slice(0, i + 1).join("/");
      if (!data[folderId]) {
        data[folderId] = {
          id: folderId,
          name: parts[i],
          isFolder: true,
          children: [],
          page: null,
        };
        data[parentId].children.push(folderId);
      }
      parentId = folderId;
    }

    // Create leaf node for the page
    const leafId = page.path;
    data[leafId] = {
      id: leafId,
      name: page.title || parts[parts.length - 1],
      isFolder: false,
      children: [],
      page,
    };

    if (!data[parentId].children.includes(leafId)) {
      data[parentId].children.push(leafId);
    }
  }

  // Sort children: folders first, then alphabetically
  for (const node of Object.values(data)) {
    node.children.sort((a, b) => {
      const aFolder = data[a]?.isFolder ? 0 : 1;
      const bFolder = data[b]?.isFolder ? 0 : 1;
      if (aFolder !== bFolder) return aFolder - bFolder;
      return (data[a]?.name ?? "").localeCompare(data[b]?.name ?? "");
    });
  }

  return data;
}
```

**Step 2: Verify typecheck**

```bash
cd ui && bun run typecheck
```

**Step 3: Commit**

```bash
git add ui/src/lib/buildPageTree.ts
git commit -m "feat(ui): add tree data builder for folder hierarchy"
```

---

## Task 5: Folder tree — headless-tree component

Replace the flat `PageList` with a folder tree using `@headless-tree/react`.

**Skill reference:** The headless-tree skill at `.claude/skills/headless-tree/SKILL.md` documents the API. Key rules:
- Always provide `rootItemId`, `getItemName`, `isItemFolder`, and a data loader
- Always include needed features in `features: []`
- Always spread `tree.getContainerProps()` on the container and `item.getProps()` on each item

**Files:**
- Create: `ui/src/components/FileTree.tsx`
- Modify: `ui/src/components/Sidebar.tsx` (replace `<PageList />` with `<FileTree />`)

**Step 1: Create FileTree component**

Create `ui/src/components/FileTree.tsx`:

```tsx
import {
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, File, Folder } from "lucide-react";
import { useMemo } from "react";
import { usePages } from "#/api/pages";
import { buildPageTree, type TreeData, type TreeNode } from "#/lib/buildPageTree";

export function FileTree() {
  const { data, isLoading, error } = usePages();
  const pages = data?.items;
  const navigate = useNavigate();

  const treeData: TreeData = useMemo(() => {
    if (!pages) return { root: { id: "root", name: "root", isFolder: true, children: [], page: null } };
    return buildPageTree(pages);
  }, [pages]);

  const tree = useTree<TreeNode>({
    rootItemId: "root",
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isFolder,
    dataLoader: {
      getItem: (id) => treeData[id],
      getChildren: (id) => treeData[id]?.children ?? [],
    },
    indent: 16,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  if (isLoading) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p>;
  }
  if (error) {
    return <p className="px-2 py-1 text-xs text-destructive">Failed to load pages</p>;
  }
  if (!pages || pages.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No pages</p>;
  }

  return (
    <div {...tree.getContainerProps()} className="text-sm">
      {tree.getItems().map((item) => {
        const node = item.getItemData();

        return (
          <button
            key={item.getKey()}
            {...item.getProps()}
            type="button"
            className="flex w-full items-center gap-1 truncate py-0.5 pr-2 text-left text-foreground hover:bg-accent"
            style={{ paddingLeft: `${item.getItemMeta().level * 16}px` }}
            onClick={() => {
              if (node.isFolder) {
                item.isExpanded() ? item.collapse() : item.expand();
              } else if (node.page) {
                navigate({ to: "/pages/$", params: { _splat: node.page.path } });
              }
            }}
          >
            {node.isFolder ? (
              <>
                <ChevronRight
                  className={`h-3 w-3 text-muted-foreground transition-transform ${
                    item.isExpanded() ? "rotate-90" : ""
                  }`}
                />
                <Folder className="h-3.5 w-3.5 text-muted-foreground" />
              </>
            ) : (
              <>
                <span className="w-3" />
                <File className="h-3.5 w-3.5 text-muted-foreground" />
              </>
            )}
            <span className="truncate">{item.getItemName()}</span>
          </button>
        );
      })}
    </div>
  );
}
```

Design notes:
- Uses `syncDataLoaderFeature` since the data is already loaded via TanStack Query
- `selectionFeature` + `hotkeysCoreFeature` for keyboard navigation (arrow keys)
- Chevron icon rotates when folder is expanded
- Folder/File icons from lucide-react
- Indentation via `paddingLeft` based on tree level
- No border-radius anywhere

**Step 2: Update Sidebar**

In `ui/src/components/Sidebar.tsx`, replace `<PageList />` with `<FileTree />`:

```tsx
import { FileTree } from "#/components/FileTree";

// In the <nav> section:
<nav className="flex-1 overflow-y-auto px-2 py-2">
  <FileTree />
</nav>
```

Remove the `PageList` import.

**Step 3: Verify typecheck**

```bash
cd ui && bun run typecheck
```

**Step 4: Commit**

```bash
git add ui/src/components/FileTree.tsx ui/src/components/Sidebar.tsx
git commit -m "feat(ui): replace flat page list with folder tree using headless-tree"
```

---

## Task 6: Storybook stories + lint pass

Create stories for the new components and run final verification.

**Files:**
- Create: `ui/src/components/ForceGraph.stories.tsx`

**Step 1: Create ForceGraph story**

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { ForceGraph } from "./ForceGraph";

const meta = {
  title: "Components/ForceGraph",
  component: ForceGraph,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ForceGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SmallGraph: Story = {
  args: {
    nodes: [
      { id: "1", path: "readme.md", title: "README" },
      { id: "2", path: "notes/daily.md", title: "Daily Notes" },
      { id: "3", path: "notes/ideas.md", title: "Ideas" },
      { id: "4", path: "projects/clepsydra.md", title: "Clepsydra" },
      { id: "5", path: "library/smith2024.md", title: "Smith 2024" },
    ],
    edges: [
      { source: "1", target: "2", kind: "wikilink" },
      { source: "2", target: "3", kind: "wikilink" },
      { source: "3", target: "4", kind: "wikilink" },
      { source: "4", target: "5", kind: "wikilink" },
      { source: "1", target: "4", kind: "wikilink" },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: "800px", height: "600px" }}>
        <Story />
      </div>
    ),
  ],
};
```

Note: SearchPalette uses keyboard listeners and router context — skip a story for it (or create a minimal no-op story). The important interactive testing happens in the dev server.

**Step 2: Run full verification**

```bash
cd ui && bun run format
cd ui && bun run lint
cd ui && bun run typecheck
cd ui && bun run build
cd ui && bun run build-storybook
cargo test
```

**Step 3: Commit**

```bash
git add ui/src/
git commit -m "feat(ui): add Storybook stories and apply formatting"
```

---

## Dependency Graph

```
Task 1 (d3 deps) ─→ Task 3 (graph viz)
Task 2 (search palette) — independent
Task 4 (tree data) ─→ Task 5 (folder tree)
Tasks 2, 3, 5 ─→ Task 6 (stories + lint)
```

Tasks 1, 2, 4 can proceed in parallel. Task 3 depends on 1. Task 5 depends on 4. Task 6 is the final pass.

---

## Notes for Implementer

1. **headless-tree skill:** Refer to `.claude/skills/headless-tree/SKILL.md` for API reference. Key points: always spread `tree.getContainerProps()` and `item.getProps()`, always include features explicitly, TypeScript shows methods that only work at runtime if the feature is imported.

2. **d3 + React integration:** d3-force runs a simulation that mutates node positions. We use `useRef` for the SVG and d3 `select()` to manipulate SVG elements directly (not via React state). This is the standard pattern for d3+React — d3 owns the SVG, React owns the component lifecycle.

3. **SVG Tailwind classes:** Tailwind v4 utility classes like `fill-foreground`, `stroke-border` work on SVG elements. Use `className` on SVG elements.

4. **Search snippet safety:** The backend returns FTS5 snippets with `<mark>` tags for highlighting. The plan strips these tags via regex for safe text rendering. If richer highlighting is desired later, use a sanitization library (e.g., DOMPurify) before innerHTML.

5. **Route generation:** TanStack Router's Vite plugin auto-generates `routeTree.gen.ts` when new route files appear in `ui/src/routes/`. Always include this file in commits.

6. **Tree rebuild on data change:** `syncDataLoaderFeature` reads from the data loader functions on each render. Since `treeData` is memoized on `pages`, the tree automatically updates when SSE events invalidate the `["pages"]` query key.

7. **Graph performance:** d3-force simulation runs on the main thread. For vaults with hundreds of pages, consider reducing simulation iterations or adding a "stop simulation" button. For now, the default settings work well up to ~200 nodes.
