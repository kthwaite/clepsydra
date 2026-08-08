# Browser Extension and Troubleshooting Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-app documentation self-contained for browser-extension setup and move Getting Started troubleshooting into a dedicated guide.

**Architecture:** Add two MDX content pages and register them in the existing static documentation registry. Keep Getting Started focused by replacing its copied/reference-only sections with internal guide links; navigation, neighboring-page links, and search continue to derive from `DOC_GROUPS`.

**Tech Stack:** React 19, TypeScript 5.9, MDX 3, TanStack Router, Vitest, Testing Library, Biome, Vite.

## Global Constraints

- Troubleshooting appears in **Start Here** after Configuration.
- Browser Extension appears in **Integrations** after MCP.
- The in-app extension guide must not require access to `extension/README.md`.
- `extension/README.md` remains unchanged as the source-tree development guide.
- Do not change extension behavior, configuration, or build output.
- Do not rewrite unrelated Getting Started sections.

---

## File Structure

- Create `ui/src/docs/content/troubleshooting.mdx`: common setup and LSP recovery guidance moved from Getting Started.
- Create `ui/src/docs/content/browser-extension.mdx`: complete in-app build, install, setup, usage, development, and recovery instructions.
- Modify `ui/src/docs/content/getting-started.mdx`: replace owned content with links to the two dedicated guides.
- Modify `ui/src/docs/registry.ts`: import, construct, and order the two pages.
- Modify `ui/src/docs/registry.test.ts`: lock the eight-page hierarchy and neighbor order.
- Modify `ui/src/docs/mdx-smoke.test.tsx`: prove both new MDX pages compile and expose their key user instructions.
- Modify `ui/src/components/docs/__tests__/DocsSidebar.test.tsx`: update the navigation-count contract and assert the new links are visible.

---

### Task 1: Dedicated Troubleshooting Guide

**Files:**
- Create: `ui/src/docs/content/troubleshooting.mdx`
- Modify: `ui/src/docs/content/getting-started.mdx:295-312`
- Modify: `ui/src/docs/registry.ts:1-52`
- Modify: `ui/src/docs/registry.test.ts:10-26`
- Modify: `ui/src/docs/mdx-smoke.test.tsx:1-54`
- Modify: `ui/src/components/docs/__tests__/DocsSidebar.test.tsx:40-62`

**Interfaces:**
- Consumes: existing MDX `meta` shape `{ slug, title, description }` and `page(groupId, meta, Component, source)` registry helper.
- Produces: registered slug `troubleshooting` at `/docs/troubleshooting`, ordered after `configuration` and before `cli`.

- [ ] **Step 1: Write failing registry and render tests**

Update the expected hierarchy and neighbors in `registry.test.ts`:

```ts
expect(DOC_GROUPS.map((group) => [group.label, group.pages.map((p) => p.slug)])).toEqual([
  ["Start Here", ["getting-started", "configuration", "troubleshooting"]],
  ["Reference", ["cli"]],
  ["Features", ["bases"]],
  ["Integrations", ["lsp", "mcp"]],
]);
expect(getDocNeighbors("configuration")).toMatchObject({
  previous: { slug: "getting-started" },
  next: { slug: "troubleshooting" },
});
expect(getDocNeighbors("troubleshooting")).toMatchObject({
  previous: { slug: "configuration" },
  next: { slug: "cli" },
});
```

Import and render the planned page in `mdx-smoke.test.tsx`:

```tsx
import Troubleshooting, {
  meta as troubleshootingMeta,
} from "#/docs/content/troubleshooting.mdx";

it("renders the dedicated troubleshooting guide", () => {
  render(<Troubleshooting />);
  expect(troubleshootingMeta.slug).toBe("troubleshooting");
  expect(
    screen.getByRole("heading", { name: "UI doesn’t load in single-binary mode" }),
  ).toBeInTheDocument();
  expect(screen.getByText("clep config path --trace")).toBeInTheDocument();
});
```

Update the sidebar test name/count and add the link assertion:

```tsx
it("renders the seven-page hierarchy, active marker, and collapsible groups", async () => {
  // existing setup and active-link assertions
  expect(within(navigation).getAllByRole("link")).toHaveLength(7);
  expect(
    within(navigation).getByRole("link", { name: "Troubleshooting" }),
  ).toHaveAttribute("href", "/docs/troubleshooting");
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun --cwd ui run test -- src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/components/docs/__tests__/DocsSidebar.test.tsx
```

Expected: FAIL because `troubleshooting.mdx` and the `troubleshooting` registry entry do not exist.

- [ ] **Step 3: Create and register the troubleshooting guide**

Create `troubleshooting.mdx` with this metadata and section structure:

```mdx
export const meta = {
  slug: "troubleshooting",
  title: "Troubleshooting",
  description: "Resolve common Clepsydra setup, server, UI, and LSP problems."
}

Use these checks when Clepsydra does not start or a client cannot connect.

## `no config.toml found`

Create `config.toml` in your current directory, or in
`$XDG_CONFIG_HOME/clepsydra/config.toml`.

## Server fails with a TLS auto-cert message

Install `mkcert` and retry, or provide `server.tls.cert_path` and
`server.tls.key_path`.

## UI doesn’t load in single-binary mode

Rebuild the embedded assets:

```bash
cd ui
bun run build
```

## UI can’t reach the backend in Vite mode

Confirm the backend is running on `http://127.0.0.1:3000` and
`server.dev_mode = true`.

## `vault already initialized`

Use a new path, or reuse the existing initialized vault.

## Neovim LSP fails to initialize or attaches then stops

No `.clepsydra` directory was found above the workspace root, and no
`config.toml` resolved either. Check `:LspLog` and run
`clep config path --trace` from the same directory. See the
[LSP guide](/docs/lsp) for complete setup and diagnostics.
```

In `registry.ts`, import the component and raw source, construct it with `page("start", ...)`, and append it to the Start Here page list:

```ts
import TroubleshootingGuide, {
  meta as troubleshootingMeta,
} from "#/docs/content/troubleshooting.mdx";
import troubleshootingSource from "#/docs/content/troubleshooting.mdx?raw";

const troubleshooting = page(
  "start",
  troubleshootingMeta,
  TroubleshootingGuide,
  troubleshootingSource,
);

{ id: "start", label: "Start Here", pages: [gettingStarted, configuration, troubleshooting] }
```

- [ ] **Step 4: Replace Getting Started troubleshooting content with the internal link**

Replace the existing `## Quick troubleshooting` section with:

```mdx
## Troubleshooting

For common configuration, server, UI, vault initialization, and LSP problems,
see the [Troubleshooting guide](/docs/troubleshooting).
```

- [ ] **Step 5: Run focused tests and verify success**

Run:

```bash
bun --cwd ui run test -- src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/components/docs/__tests__/DocsSidebar.test.tsx
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the troubleshooting guide**

```bash
git add ui/src/docs/content/troubleshooting.mdx ui/src/docs/content/getting-started.mdx ui/src/docs/registry.ts ui/src/docs/registry.test.ts ui/src/docs/mdx-smoke.test.tsx ui/src/components/docs/__tests__/DocsSidebar.test.tsx
git commit -m "docs(ui): add troubleshooting guide"
```

---

### Task 2: Self-contained Browser Extension Guide

**Files:**
- Create: `ui/src/docs/content/browser-extension.mdx`
- Modify: `ui/src/docs/content/getting-started.mdx:289-293`
- Modify: `ui/src/docs/registry.ts:1-52`
- Modify: `ui/src/docs/registry.test.ts:10-26`
- Modify: `ui/src/docs/mdx-smoke.test.tsx:1-54`
- Modify: `ui/src/components/docs/__tests__/DocsSidebar.test.tsx:40-62`

**Interfaces:**
- Consumes: registry and Start Here ordering produced by Task 1.
- Produces: registered slug `browser-extension` at `/docs/browser-extension`, ordered after `mcp` as the final guide.

- [ ] **Step 1: Write failing registry and render tests**

Extend the hierarchy and final-neighbor assertions in `registry.test.ts`:

```ts
expect(DOC_GROUPS.map((group) => [group.label, group.pages.map((p) => p.slug)])).toEqual([
  ["Start Here", ["getting-started", "configuration", "troubleshooting"]],
  ["Reference", ["cli"]],
  ["Features", ["bases"]],
  ["Integrations", ["lsp", "mcp", "browser-extension"]],
]);
expect(getDocNeighbors("mcp").next?.slug).toBe("browser-extension");
expect(getDocNeighbors("browser-extension").previous?.slug).toBe("mcp");
expect(getDocNeighbors("browser-extension").next).toBeUndefined();
```

Import and render the planned page in `mdx-smoke.test.tsx`:

```tsx
import BrowserExtension, {
  meta as browserExtensionMeta,
} from "#/docs/content/browser-extension.mdx";

it("renders self-contained browser extension setup", () => {
  render(<BrowserExtension />);
  expect(browserExtensionMeta.slug).toBe("browser-extension");
  expect(
    screen.getByRole("heading", { name: "Install in Chrome, Chromium, Brave, or Edge" }),
  ).toBeInTheDocument();
  expect(screen.getByText("extension/dist", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("Connected", { exact: true })).toBeInTheDocument();
});
```

Update the sidebar contract:

```tsx
it("renders the eight-page hierarchy, active marker, and collapsible groups", async () => {
  // existing setup and active-link assertions
  expect(within(navigation).getAllByRole("link")).toHaveLength(8);
  expect(
    within(navigation).getByRole("link", { name: "Browser Extension" }),
  ).toHaveAttribute("href", "/docs/browser-extension");
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun --cwd ui run test -- src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/components/docs/__tests__/DocsSidebar.test.tsx
```

Expected: FAIL because `browser-extension.mdx` and the `browser-extension` registry entry do not exist.

- [ ] **Step 3: Create the complete Browser Extension guide**

Create `browser-extension.mdx` with metadata:

```mdx
export const meta = {
  slug: "browser-extension",
  title: "Browser Extension",
  description: "Build, install, configure, and use the Clepsydra web archive extension."
}
```

Add these sections with the exact operational facts from `extension/README.md`:

1. **Prerequisites** — Bun, `cargo run -- serve`, and the `GET /api/vault/archive/status` plus `POST /api/vault/archive` endpoints.
2. **Build the extension** — `bun install`, `bun run typecheck`, `bun run build`, and `bun run build:firefox`; explain `extension/dist` and `extension/dist-firefox`.
3. **Install in Chrome, Chromium, Brave, or Edge** — browser extension URL, Developer mode, Load unpacked, select `extension/dist`, optionally pin.
4. **Install temporarily in Firefox** — build Firefox bundle, open `about:debugging#/runtime/this-firefox`, Load Temporary Add-on, select `extension/dist-firefox/manifest.json`, and state that restart removes temporary add-ons.
5. **First-time setup** — Settings, Server URL default `http://localhost:3000`, optional tags/notifications, Save, and `Connected` status.
6. **Capture a page** — popup action and `Ctrl+Shift+S`/`Command+Shift+S` shortcuts.
7. **Development workflow** — `bun run dev`, then reload from the Chromium extensions page or reload the Firefox temporary add-on.
8. **Troubleshooting** — server unreachable/status endpoint, reload after rebuild, normal `http://` or `https://` page requirement, and Content Changed conflict semantics.

The page must contain all commands, paths, and browser URLs directly; do not link to `extension/README.md` as a prerequisite.

- [ ] **Step 4: Register the Browser Extension guide**

In `registry.ts`, import the component and raw source, construct it with `page("integrations", ...)`, and append it after MCP:

```ts
import BrowserExtensionGuide, {
  meta as browserExtensionMeta,
} from "#/docs/content/browser-extension.mdx";
import browserExtensionSource from "#/docs/content/browser-extension.mdx?raw";

const browserExtension = page(
  "integrations",
  browserExtensionMeta,
  BrowserExtensionGuide,
  browserExtensionSource,
);

{
  id: "integrations",
  label: "Integrations",
  pages: [lsp, mcp, browserExtension],
}
```

- [ ] **Step 5: Replace Getting Started’s repository reference**

Replace `## 10) Optional: Browser extension` and its `extension/README.md` reference with:

```mdx
## 10) Optional: Browser extension

To archive web pages into Clepsydra, follow the complete
[Browser Extension guide](/docs/browser-extension).
```

- [ ] **Step 6: Run focused tests and verify success**

Run:

```bash
bun --cwd ui run test -- src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/components/docs/__tests__/DocsSidebar.test.tsx
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the browser extension guide**

```bash
git add ui/src/docs/content/browser-extension.mdx ui/src/docs/content/getting-started.mdx ui/src/docs/registry.ts ui/src/docs/registry.test.ts ui/src/docs/mdx-smoke.test.tsx ui/src/components/docs/__tests__/DocsSidebar.test.tsx
git commit -m "docs(ui): add browser extension guide"
```

---

### Task 3: Full Verification and Render Smoke Test

**Files:**
- Verify only; modify files only if a gate exposes a defect in the preceding tasks.

**Interfaces:**
- Consumes: registered `/docs/troubleshooting` and `/docs/browser-extension` routes.
- Produces: verification evidence for all required quality gates and both rendered documentation routes.

- [ ] **Step 1: Run UI typecheck**

```bash
bun --cwd ui run typecheck
```

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 2: Run UI lint**

```bash
bun --cwd ui run lint
```

Expected: exit 0 with no Biome errors.

- [ ] **Step 3: Run the complete UI test suite**

```bash
bun --cwd ui run test
```

Expected: exit 0 with all Vitest tests passing.

- [ ] **Step 4: Build the production UI**

```bash
bun --cwd ui run build
```

Expected: TypeScript and Vite complete successfully and emit `ui/dist`.

- [ ] **Step 5: Launch and exercise the documentation UI**

Start the Vite development server with the project process manager, open `/docs/troubleshooting` and `/docs/browser-extension` in Chromium, and verify:

- the Troubleshooting page renders its title and all six problem headings;
- the Browser Extension page renders its title, install sections, setup instructions, and troubleshooting section;
- Getting Started links navigate to both dedicated pages; and
- both new sidebar entries appear in the approved groups.

- [ ] **Step 6: Run Rust verification gates**

```bash
cargo check --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets
```

Expected: every command exits 0.

- [ ] **Step 7: Commit any verification-only corrections**

If a gate required a correction, stage only those corrected files and commit:

```bash
git commit -m "docs(ui): fix documentation verification findings"
```

If no corrections were required, do not create an empty commit.
