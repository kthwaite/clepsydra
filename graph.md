Yes. At your graph sizes, I would seriously consider moving away from the D3 rendering/interaction stack, although I wouldn't assume `d3-force` itself is necessarily the problem.

For an Obsidian-style PKMS graph, my shortlist would be:

| Stack | Rendering | Layout | Main thread? | My take |
|---|---|---|---|---|
| **Sigma.js + Graphology + ForceAtlas2** | WebGL | ForceAtlas2 | layout can run in worker | **Best fit** |
| **AntV G6** | Canvas / WebGL | several, incl. ForceAtlas2 | worker / WASM / GPU options | Best batteries-included option |
| **Cosmograph** | WebGL | GPU force simulation | GPU | Fastest / most extreme |
| **D3 + custom Canvas/WebGL** | your choice | d3-force | worker if you arrange it | Least migration, more plumbing |
| Cytoscape.js | Canvas | large layout ecosystem | varies | Excellent graph API, less compelling for this particular performance problem |

### 1. Sigma.js + Graphology is where I'd start

This is almost exactly the niche Sigma targets: interactive network visualisation of thousands of nodes/edges. Sigma does the rendering in WebGL and uses Graphology as the graph/data layer. :chatgpt-content-reference{index="0"}

The particularly nice combination is:

```text
Graphology
    │
    ├── graph data / attributes / algorithms
    │
    ├── graphology-layout-forceatlas2
    │       └── Web Worker
    │
    └── Sigma.js
            └── WebGL renderer / camera / picking / events
```

Graphology's ForceAtlas2 implementation explicitly supplies a Web Worker supervisor, and it has Barnes–Hut optimisation so repulsion can go from quadratic behaviour to approximately `O(n log n)`. :chatgpt-content-reference{index="1"}

That separation is rather attractive for a PKMS. Your React/Zustand application can own semantic state while Graphology owns the hot graph representation and Sigma owns transient visual state.

Something approximately like:

```ts
import Graph from "graphology";
import Sigma from "sigma";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import forceAtlas2 from "graphology-layout-forceatlas2";
import random from "graphology-layout/random";

const graph = new Graph();

for (const node of nodes) {
  graph.addNode(node.id, {
    label: node.title,
    size: 5,
    color: node.color,
  });
}

for (const edge of edges) {
  graph.addEdge(edge.source, edge.target);
}

random.assign(graph);

const renderer = new Sigma(graph, container);

const layout = new FA2Layout(graph, {
  settings: {
    ...forceAtlas2.inferSettings(graph),
    barnesHutOptimize: true,
  },
});

layout.start();
```

You get WebGL rendering and GPU picking, while the expensive layout isn't blocking pointer interaction.

For your scale—100 to 1,000 nodes—that ought to be extremely comfortable.

One caveat as of September 2026: **Sigma 3 is the stable line; Sigma 4 is currently alpha**. V4 is interesting because it moves labels into WebGL and adds things like built-in dragging and a substantially redesigned declarative rendering system, but I'd use v3 for a production PKMS unless a v4 feature is compelling enough to tolerate churn. :chatgpt-content-reference{index="2"}

### 2. G6 has become surprisingly compelling

I would investigate **AntV G6 5.1** before choosing, because its current architecture is quite a bit more sophisticated than older G6 versions.

It gives you the whole stack:

- Canvas by default, optional **WebGL renderer**
- zoom/pan
- node dragging
- force-aware dragging
- click/brush/lasso selection
- ForceAtlas2
- D3 force
- its own force layout
- Fruchterman
- layouts in **Web Workers**
- several layouts implemented in **Rust/WASM**
- GPU implementations of Fruchterman/GForce :chatgpt-content-reference{index="3"}


For example, worker execution is basically:

```ts
layout: {
  type: "force-atlas2",
  enableWorker: true,
}
```

And their WASM package includes Force, ForceAtlas, Fruchterman and Dagre implementations. :chatgpt-content-reference{index="4"}

This means G6 could replace essentially all four of your current packages:

```text
d3-force
d3-drag
d3-selection
d3-zoom
```

with one coherent interaction/rendering framework.

It even has an `optimize-viewport-transform` behaviour that hides expensive nonessential visual elements while you're panning/zooming, then restores them afterwards. :chatgpt-content-reference{index="5"}

The tradeoff is that **G6 is much more of a framework**. Sigma feels more like a renderer you embed into your application. Given the kind of application architecture you've been using, I suspect Sigma's smaller conceptual surface will suit you better. 

### 3. Cosmograph is the nuclear option

If your eventual graph might grow from 1,000 nodes to 100k+, **Cosmograph** is worth knowing about.

Its distinguishing feature is that it doesn't just render on the GPU: **the force simulation itself runs on the GPU**. Their current library supports WebGL rendering, GPU layout, dragging, labels, clustering forces, etc. :chatgpt-content-reference{index="7"}

They target graphs orders of magnitude bigger than yours:

> GPU layout → WebGL → hundreds of thousands/millions of items

At 500 nodes this is hilariously overqualified, but it gives you essentially unlimited headroom.

There's a significant catch, though: the library is **free for non-commercial use and pre-revenue startups**, rather than conventionally MIT/Apache licensed; commercial use requires their commercial licence. :chatgpt-content-reference{index="8"}

For a private PKMS that's fine. For something you might eventually sell, I'd factor that into the architecture now.

---

## But 1,000 nodes really shouldn't cripple d3-force

This is the bit I'd investigate before rewriting anything.

`d3-force`'s many-body force already uses a quadtree/Barnes–Hut approximation. D3 explicitly recommends workers for large static layouts, but 100–1000 nodes is not inherently a large simulation. :chatgpt-content-reference{index="9"}

If you're seeing obviously bad performance at ~500 nodes, I'd profile these separately:

```text
                        current frame
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
          physics         rendering      application
       d3-force tick      SVG / Canvas    React/Zustand
             │               │               │
        manyBody()      edge drawing     state updates
        collide()       text labels      reconciliation
        forceLink()     hit testing      selectors
```

In particular, there are four very common traps.

### SVG rendering

If every node and edge is an SVG object and every tick does:

```ts
node.attr("cx", d => d.x).attr("cy", d => d.y);
link
  .attr("x1", ...)
  .attr("y1", ...)
  ...
```

I'd bet on **rendering rather than simulation**.

500 nodes + 1,500 edges means thousands of DOM attribute mutations per frame.

Moving exactly the same D3 simulation to Canvas can make the issue disappear.

### React state on every tick

This one is particularly nasty:

```ts
simulation.on("tick", () => {
  setNodes([...simulation.nodes()]);
});
```

or:

```ts
zustandStore.setState({ nodes: ... });
```

Don't.

I'd keep simulation coordinates completely outside React:

```text
persistent app state
    ↓
graph model

             simulation mutable state
                      ↓
             renderer mutable state
                      ↓
                    GPU
```

React should hear about things like:

- node selected
- node pinned
- edge added
- graph filter changed

not:

- node 382 moved from `(123.2, 31.4)` to `(123.7, 31.8)`.

### Collision forces

`forceCollide` can become surprisingly expensive, especially if you've raised its iteration count. D3 explicitly notes that increasing collision iterations increases runtime considerably. :chatgpt-content-reference{index="10"}

For a note graph I'd normally use:

```ts
forceCollide(radius)
  .strength(0.7)
  .iterations(1)
```

rather than trying to produce perfect packing every frame.

### Unlimited repulsion range

An easy D3 win that is surprisingly underused:

```ts
forceManyBody()
  .strength(-50)
  .distanceMax(400)
```

D3 explicitly notes that a finite `distanceMax` improves performance. :chatgpt-content-reference{index="11"}

For a PKMS graph, nodes 3,000 world-units apart generally don't need to exert meaningful repulsion on each other anyway.

---

# One architectural change I'd make regardless

I wouldn't continuously simulate the entire PKMS graph.

I'd treat positions as **persistent-ish state**:

```text
initial load
    │
    ▼
stored x/y positions
    │
    ├── existing nodes remain stable
    │
    └── new nodes initialise near neighbours
             │
             ▼
      short local/global relaxation
             │
             ▼
          settle/freeze
```

Then dragging a node can briefly reheat the layout:

```text
drag start
   ↓
restart / low alpha target
   ↓
drag node
   ↓
drag end
   ↓
cool → stop
```

This has two benefits.

One is performance.

The more important one is **spatial memory**. In a PKMS, constantly rearranging a graph undermines one of the useful properties of the visualization: "that project cluster lives over there". A graph that moves only when its topology meaningfully changes is considerably more useful than a mathematically pristine layout that constantly swims around.

ForceAtlas2 is particularly good for this kind of continuous/stable network map because that's basically the use case it was designed for.

---

## What I'd test

I'd spend an afternoon prototyping two implementations against one representative graph—say **1k nodes / 3–5k edges**:

**A. Sigma 3**

```text
graphology
+
graphology-layout-forceatlas2/worker
+
Sigma WebGL
```

**B. G6 5.1**

```text
G6 WebGL
+
ForceAtlas2
+
enableWorker
```

My expectation is that either will make 1k nodes feel utterly routine.

I'd favour **Sigma + Graphology** if the graph is one specialised view inside your PKMS. I'd favour **G6** if the graph is becoming an application unto itself—with lasso selection, multiple layouts, clustering, custom interaction modes, compound nodes, etc. Cosmograph only becomes my first choice if you're deliberately designing for **tens/hundreds of thousands of visible nodes**.

And before migrating, run a profiler once. If your flame graph says `commitRoot`, SVG attribute changes, label measurement, or Zustand selectors rather than `forceManyBody`, swapping the physics engine for WASM won't fix the actual problem.
