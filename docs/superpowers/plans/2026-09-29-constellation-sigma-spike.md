# Constellation: Sigma / Graphology evaluation

Date: 2026-09-29
Status: plan only; no prototype or measurements yet.
Input: [`graph.md`](../../../graph.md).

## Decision to answer

Can Sigma 3 + Graphology + worker-based ForceAtlas2 make Constellation materially more responsive at 1,000 nodes / 3,000–5,000 edges, without losing its navigation, visual language, touch targets, or spatial stability?

Run a reversible comparison, not a production migration. Keep D3 as the control. Do not evaluate G6/Cosmograph, change the API, persist layout positions to the vault, or add graph features in this spike. Sigma 4 is explicitly outside scope: the official site currently describes it as alpha [S1]. Pin exact compatible stable package versions when starting and record them with the results.

## What the repository already does

- `ui/src/components/ForceGraph.tsx`: D3 force simulation on the main thread, SVG nodes/edges/labels, and imperative DOM updates on each tick. Coordinates are already outside React/Zustand. Forces are link distance 80, charge -200, centering, and collision radius 20. D3 cools normally; this is not an indefinitely running simulation.
- `ForceGraph` rebuilds when `nodes`, `edges`, or `onNodeClick` changes. `Constellation.tsx` creates its click handler on each render. Rebuilds clear the SVG, recreate simulation positions, and reset zoom. Profile their frequency; do not assume physics alone explains responsiveness.
- `ui/src/components/codex/Constellation.tsx`: owns the desktop surface, filters, sidebar, hubs/legend, and opening a page through `useOpenTab`.
- `ui/src/components/codex/constellation-filters.ts`: hides journals/tasks/orphans and applies undirected neighbourhood traversal at depth 1/2/all. Reuse it unchanged for both candidates.
- `ui/src/components/codex/MobileConstellation.tsx`: graph/list modes, anchor selection, depth 1/2, and an anchor requirement above 18 visible nodes. Preserve this policy; faster rendering does not justify removing it.
- `ui/src/store/constellation.ts`: semantic view state only; no coordinate persistence.
- `ui/src/components/TabContent.tsx`: lazy-loads Constellation. Keep candidate dependencies off the normal workspace load path.
- `useGraph()` reads `/api/vault/index/graph`. Nodes are `{id, path, title?}`; edges are `{source, target, kind}` without edge IDs. No backend or generated schema changes are needed.
- Existing visual contract: project square, task/todo triangle, journal ring, AI-journal dashed ring, other dot; kind colours; low-opacity accent edges; Geist labels using title or path; live bone/charcoal switching; 44×44 CSS-pixel hit regions independent of zoom; click to open, drag to move, background pan/zoom.

These are source observations, not measured bottlenecks.

## Evaluation architecture

```text
Same immutable API-shaped fixture + existing applyFilters
    ├── current ForceGraph (D3 / SVG control)
    └── SigmaGraphPrototype
          ├── Graphology: graph attributes and mutable x/y
          ├── ForceAtlas2 worker: bounded relaxation
          └── Sigma: WebGL rendering, camera and picking

React / Zustand: filters, selected anchor, view mode and page navigation only
```

Use direct Sigma integration, not an additional React wrapper. Match the existing `nodes`, `edges`, `onNodeClick` boundary. Do not introduce a general renderer framework.

Keep graph/renderer/worker instances in refs with explicit lifetimes. Changing a callback or theme must not reconstruct topology. Copy fixture data into the mutable graph once; never mutate query-cache objects or emit per-tick React/store updates. Reconcile topology changes by node ID, preserving survivor positions and camera state.

Use an in-memory position cache for nodes hidden and restored by filters. Seed genuinely new nodes near neighbours, with deterministic jitter; use seeded non-coincident positions for disconnected nodes. No localStorage, server storage, or promise of cross-session persistence.

Graphology defaults to a simple graph [S5]. Start with `MultiDirectedGraph` so reciprocal links, multiple kinds between a pair, and self-links cannot cause accidental loss or insertion errors. Preserve edge kind and multiplicity; use deterministic keys from source/target/kind plus occurrence index. Render without arrows to match the current view. Ignore dangling endpoints as the existing renderer does, and report their count in fixture diagnostics. Inspect representative API data before changing any edge semantics; do not silently deduplicate or invent weights.

## Work sequence

### 1. Capture fixtures and profile the existing view

**Deliverable:** reproducible fixtures, baseline traces, and a short bottleneck attribution.

- Use a dedicated throwaway branch from `develop`; keep the production default on D3 throughout the experiment.
- Build a prototype story beside the renderer, using the existing Storybook setup: proposed `ui/src/components/ConstellationGraphPrototype.stories.tsx` and `SigmaGraphPrototype.tsx`. Start with `cd ui && bun run storybook`. Only one renderer is mounted at a time; a selector switches implementation while retaining fixture and filter inputs.
- Include the unmodified `ForceGraph` as the baseline. Capture one real Constellation trace too, so the isolated harness does not hide React/store integration costs.
- Capture a representative graph read-only through the existing API. Keep private titles/paths out of committed artifacts; use a local snapshot or anonymize labels while preserving kind paths, topology, and label-length distribution.
- Generate deterministic synthetic fixtures with a recorded seed. Include hubs, clusters, bridges, disconnected components, orphans, reciprocal links, long labels, all glyph kinds, and a small multi-edge/self-link case—not just a uniform random graph.

| Fixture | Purpose |
|---|---|
| Empty, singleton, and 18/19-node cases | Empty rendering and mobile policy boundary |
| 100 nodes / about 300 edges | Small-graph overhead and visual review |
| 500 nodes / about 1,500 edges | Intermediate scaling |
| 1,000 nodes / 3,000 edges and / 5,000 edges | Primary acceptance workloads |
| Representative vault snapshot | Real topology, labels and kinds |
| 5,000 nodes / about 20,000 edges | Optional headroom; not a release requirement |

Profile cold mount, active layout, settled idle, pan/zoom, drag, filtering, sidebar resize, and a parent rerender with unchanged data. Separate force work, SVG paint/attribute work, label work, React commits, graph reconstruction, and API/filter latency. Keep fetch time separate from rendering time.

Use temporary diagnostic variants to isolate causes: frozen layout with interactions; labels off; simulation running without tick painting. If callback-triggered reconstruction dominates, measure a callback-stabilized D3 control too, without replacing the unmodified baseline. This prevents crediting a lifecycle fix to WebGL.

**Exit:** a trace-backed diagnosis, not “D3 is slow.” No production fixes in this task.

### 2. Prove the minimal Sigma / worker path

**Deliverable:** a runnable, clearly labelled prototype with visible layout state and diagnostics.

- Install pinned stable `sigma`, `graphology`, and `graphology-layout-forceatlas2` on the spike branch only. Avoid another layout package if seeded initialization can be kept local.
- Initialize finite, non-coincident `x/y` before starting ForceAtlas2; all-zero positions are a documented failure case [S2]. Use `inferSettings` as a starting point, explicitly enable Barnes–Hut, and record the resulting settings.
- Prove the layout actually runs in a worker in browser DevTools. A worker still causes main-thread graph updates and renderer processing; measure those, not just worker compute time [S3].
- Show counts, seed, settings, running/stopped state, elapsed layout time, and measured frame statistics. Provide start/stop/reset controls for repeatable runs.
- Start with plain nodes and labels only to establish a lower-bound cost. This stage cannot earn a migration go decision.
- Check development and production bundles. Verify worker creation under the actual served application's CSP and deployment path; do not assume Storybook success proves the embedded UI works.
- Confirm `layout.kill()` and `renderer.kill()` run on teardown, with observer/listener/timer cleanup [S2, S3]. Exercise development Strict Mode mount/unmount and repeated switches.

**Exit:** browser-observed worker execution, interactive rendering, and clean disposal in development and a production build.

### 3. Establish interaction and visual parity early

**Deliverable:** the candidate inside the existing desktop and mobile Constellation surfaces, behind a temporary development-only switch.

Keep the switch local to the spike; do not introduce persisted product settings or a new public route. Both surfaces consume the same filtered data and existing page-open callback. Use the normal `bun run dev` flow against a scratch vault for application smoke, not writes to the live vault.

| Concern | Required scenario / proof |
|---|---|
| Navigation | Clicking/tapping opens the correct path once; background interaction does not open a page; drag release does not become a click |
| Dragging | Drag during layout and after stop; pan must not fight node drag; release resumes only bounded relaxation |
| Worker race | Pause layout while dragging and verify an in-flight worker result cannot snap the node back; inspect the pinned worker implementation before choosing pause/restart vs kill/recreate |
| Hit targets | Prove 44×44 CSS-pixel picking independently of small visible glyphs, at min/default/max zoom and DPR 1/2; examine overlapping-target ambiguity |
| Glyphs | All five existing silhouettes, including hollow and dashed rings, remain distinguishable at normal size in both themes |
| Theme and labels | Resolve actual computed token colours; switch bone/charcoal without losing positions; use Geist and title/path fallback; long and non-ASCII labels remain usable |
| Labels under load | Compare always-on labels with Sigma's label-selection policy. Report visible label count and hover discoverability. Do not claim a rendering win merely by hiding labels |
| Filters and topology | Existing hide/depth/anchor/orphan semantics unchanged; rapid filter toggles, empty result, add/remove/rename, and refresh retain correct navigation and no dangling visual edges |
| Resize | Toggle sidebar; resize container; hide/show tab; cross mobile breakpoint; no blank canvas, unintended camera reset, or duplicated worker |
| Mobile | Existing graph/list and 18-node policy unchanged; touch tap/drag/pinch tested on Safari/iOS where available; emulation is not equivalent evidence |
| Accessibility / failure | Preserve graph name and existing list/control access. Check keyboard controls and page links. WebGL unavailable/context lost must be an explicit blocker or show an actionable non-graph path, never a silent blank canvas |

Sigma's core node programs are circles; custom rendering and GPU picking are extension points, not automatic parity [S4]. Prototype glyph and enlarged-picking programs before spending effort tuning ForceAtlas2. Reuse maintained compatible programs where they fit; record any custom shader/atlas maintenance cost. Do not add one DOM overlay per node to recover parity without measuring its cost.

**Exit:** screenshots and interaction recordings from the real surface. Any unresolved glyph, picking, drag, or mobile regression blocks adoption.

### 4. Test bounded layout and spatial memory

**Deliverable:** evidence that the graph can settle and remain still without losing responsiveness.

ForceAtlas2's supervisor exposes start/stop/kill, not D3's alpha cooling API [S2]. Explicitly implement an experimental stop policy instead of copying D3 restart semantics:

- Sample displacement at low frequency, in graph coordinates normalized against a fixed reference extent. Stop after sustained low movement, with a hard maximum runtime (initial trial: 5 seconds).
- Log whether each run stopped by stability or timeout. A timeout alone does not prove a useful layout.
- Pause on document hiding; stop when the graph surface is inactive; kill on unmount. Verify the workspace's actual tab lifecycle rather than assuming inactive means unmounted.
- On drag, pause worker writes, move the node, then resume a short bounded relaxation. Do not add permanent pinning as a new product feature.
- Keep positions and camera on theme changes, resize, equivalent query refresh, and unrelated parent renders. On filter-off/filter-on, restore cached positions before relaxation. Test a 1% topology addition and a high-degree-node removal separately.
- Compare screenshots and node displacement before/after changes. Inspect cluster readability, disconnected components, label collisions and whether a user can relocate a known page. ForceAtlas2 does not by itself guarantee spatial memory.

**Exit:** no continuous layout after settling; recorded stability/timeout rates; no resets from non-topology changes; acceptable visual movement on actual topology changes.

### 5. Run the controlled comparison and decide

**Deliverable:** a results table, trace/screenshot artifacts, and an explicit go/no-go verdict.

Run production builds, foreground tab, fixed viewport/DPR and power conditions; record machine, OS, browser, package versions, seed, label policy, graph counts, and layout settings. Test Chromium and Safari on desktop; include a representative mobile device if mobile replacement is proposed.

Perform one warm-up plus five measured runs per primary scenario, alternating candidate order. Use identical fixtures and starting coordinates for rendering-only comparisons; compare each engine's native layout separately. Never compare a fully settled candidate against an actively simulating control.

Record:

- Graph-data-ready → first painted usable graph, separated from network fetch and layout settling.
- p50/p95/p99 frame intervals during a fixed 10-second pan/zoom sequence, both with layout active and stopped. Treat rAF timing as a proxy; use performance traces to inspect missed frames.
- p95 pointer action → next visual response, sampled across repeated gestures with trace marks/screenshots; do not substitute handler duration or claim synthetic actions are field INP.
- Main-thread time, long tasks (>50ms), React commits, layout-update frequency, and renderer processing cost.
- Time to stop and stop reason; idle CPU/frame activity over 30 seconds after stopping.
- Heap/resource trends after 20 mount/unmount cycles, plus active workers and retained renderer instances. Include GPU resources/context warnings where tooling exposes them; heap alone is insufficient.
- Added compressed lazy-chunk size, worker packaging, and cold-load impact. Record rather than invent a bundle-size ceiling.

Proposed acceptance budgets—not current measurements—on the recorded primary desktop at 1,000 nodes / 5,000 edges:

| Gate | Target |
|---|---|
| First usable graph, data already available | ≤1 second |
| Pan/zoom while layout runs | p95 frame interval ≤20ms on a 60Hz display; p99 ≤50ms |
| Pointer-to-visual response | p95 ≤50ms |
| Meaningful advantage | ≥30% reduction in the measured dominant main-thread interaction cost versus D3; if D3 already meets budgets comfortably, require a concrete parity/maintenance benefit rather than a marginal benchmark win |
| Bounded work | Layout stops within 5 seconds, with acceptable layout quality; no continuing worker computation while settled or hidden |
| Lifecycle | Zero live candidate workers/renderers after unmount; no increasing retained-instance trend across cycles |
| Product parity | All stage-3 scenarios pass; no silently reduced glyph, target, label, navigation, or mobile contract |

Mobile gets its own recorded frame/latency results at the graphs permitted by current policy; do not apply a desktop headline to an untested phone. Missing target-browser/device evidence produces a qualified result, not an unconditional migration recommendation.

## Verification and test scope

This planning change requires no runtime execution. During the spike, browser smoke and production-build traces are the primary proof; jsdom cannot verify WebGL, GPU picking, or worker performance.

After the experimental code is integrated, run the repository gates once: from `ui/`, `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build`. Record existing unrelated failures separately. Exercise the built UI, not only Storybook. Do not write permanent benchmark assertions or mocked-Sigma wiring tests for throwaway code.

If adoption is approved, preserve consumer-level filter/navigation/mobile coverage in `constellation-filters.test.ts`, `codex/__tests__/Constellation.test.tsx`, `MobileConstellation.test.tsx`, `CodexFrameBreakpoint.integration.test.tsx`, and `FolioNavigation.test.tsx`. Remove obsolete SVG/D3-internal assertions in `ForceGraph.test.tsx` and SVG-text inspection helpers in mobile tests rather than re-pinning them to canvas implementation details. Add regression coverage only for demonstrated bugs or uncertain consumer-visible boundaries, such as duplicate-edge handling, drag-click separation, and position retention.

## Final decision and handoff

- **Go:** budgets and parity pass, custom-rendering maintenance is acceptable, and the comparison demonstrates a meaningful benefit. Produce a separate clean-cutover implementation plan for all renderer callers/tests/docs. Audit remaining D3 usage before removing dependencies. No permanent dual-renderer flag.
- **No-go:** parity requires disproportionate custom rendering, worker/update costs erase gains, or current D3 plus a small lifecycle correction is already sufficient. Retain D3; use the trace evidence to propose a focused fix rather than another speculative rewrite.
- **Inconclusive:** name the missing evidence or failing criterion precisely; retain D3 as default. Do not call a fast plain-circle demo adoption-ready.

Archive the runnable prototype on the throwaway branch, with exact launch commands and fixture seed. Keep a concise results note linking traces, screenshots, package versions, and the verdict; never commit private vault snapshots. No production migration, backend change, or persistent layout storage is authorized by this plan.

## Primary sources

- **S1:** [Sigma introduction and v4 alpha notice](https://www.sigmajs.org/docs/).
- **S2:** [Graphology ForceAtlas2: initialization, Barnes–Hut, inferred settings, worker lifecycle](https://graphology.github.io/standard-library/layout-forceatlas2.html).
- **S3:** [Sigma lifecycle: graph-event processing, rendering and disposal](https://www.sigmajs.org/docs/advanced/lifecycle/).
- **S4:** [Sigma renderers: core programs, custom programs and picking](https://www.sigmajs.org/docs/advanced/renderers/).
- **S5:** [Graphology instantiation: graph types, parallel edges and self-loops](https://graphology.github.io/instantiation.html).
- **S6:** [Sigma settings: label and rendering controls](https://www.sigmajs.org/docs/typedoc/sigma/src/settings/interfaces/Settings).

Sources checked while preparing this plan. The transcript's performance expectations remain hypotheses until the spike measures them.
