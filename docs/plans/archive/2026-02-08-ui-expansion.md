# UI Expansion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first functional UI — a page explorer with sidebar, markdown page viewer, backlinks panel, and vault stats dashboard — consuming the existing backend APIs.

**Architecture:** TanStack Query hooks wrap all `/api/vault/*` endpoints. A two-panel layout (sidebar + content area) provides navigation. File-based routes under `/pages/$` render individual pages with `react-markdown`. The brutalist design language (hard edges, achromatic palette, offset shadows) carries through all new components.

**Tech Stack:** React 19, TanStack Router (file-based), TanStack Query, `react-markdown` + `remark-gfm` + `remark-wiki-link` (markdown rendering with wikilink support), `react-aria-components` (accessible primitives), Tailwind v4, Storybook 10.

---

## Task 1: Install markdown rendering dependencies

**Files:**
- Modify: `ui/package.json`

**Step 1: Install packages**

```bash
cd ui
bun add react-markdown remark-gfm remark-wiki-link rehype-raw
```

- `react-markdown` — React component for rendering markdown
- `remark-gfm` — GitHub Flavored Markdown (tables, strikethrough, task lists)
- `remark-wiki-link` — Parses `[[wikilinks]]` into linkable nodes
- `rehype-raw` — Allows raw HTML passthrough in markdown

**Step 2: Verify build**

```bash
cd ui && bun run typecheck
```

**Step 3: Commit**

```bash
git add ui/package.json ui/bun.lock
git commit -m "chore(ui): add react-markdown and remark plugins"
```

---

## Task 2: API client hooks

Create typed TanStack Query hooks for the backend API endpoints the UI needs.

**Files:**
- Create: `ui/src/api/pages.ts`
- Create: `ui/src/api/index.ts`
- Create: `ui/src/api/types.ts`

**Step 1: Create shared types**

Create `ui/src/api/types.ts`:

```typescript
export interface PageSummary {
  id: string;
  path: string;
  title: string | null;
  canonical_name: string;
}

export interface PageDetail {
  path: string;
  canonical_name: string;
  meta: PageMeta;
  body: string;
}

export interface PageMeta {
  id: string;
  title: string | null;
  tags: string[];
  aliases: string[];
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface BacklinkEntry {
  source_id: string;
  source_path: string;
  source_title: string | null;
  target_raw: string;
  kind: string;
  context: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  path: string;
  title: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface VaultStats {
  pages: number;
  links_total: number;
  links_resolved: number;
  links_unresolved: number;
  tags: number;
  attachments: number;
}
```

**Step 2: Create pages API hooks**

Create `ui/src/api/pages.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { PageDetail, PageSummary } from "./types";

async function fetchPages(): Promise<PageSummary[]> {
  const res = await fetch("/api/vault/pages");
  if (!res.ok) throw new Error(`Failed to fetch pages: ${res.status}`);
  return res.json();
}

async function fetchPage(path: string): Promise<PageDetail> {
  const res = await fetch(`/api/vault/pages/${encodeURI(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch page: ${res.status}`);
  return res.json();
}

export function usePages() {
  return useQuery({
    queryKey: ["pages"],
    queryFn: fetchPages,
  });
}

export function usePage(path: string) {
  return useQuery({
    queryKey: ["pages", path],
    queryFn: () => fetchPage(path),
    enabled: !!path,
  });
}
```

**Step 3: Create index API hooks**

Create `ui/src/api/index.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { BacklinkEntry, GraphResponse, TagCount, VaultStats } from "./types";

async function fetchBacklinks(path: string): Promise<BacklinkEntry[]> {
  const res = await fetch(`/api/vault/index/backlinks/${encodeURI(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch backlinks: ${res.status}`);
  return res.json();
}

async function fetchTags(): Promise<TagCount[]> {
  const res = await fetch("/api/vault/index/tags");
  if (!res.ok) throw new Error(`Failed to fetch tags: ${res.status}`);
  return res.json();
}

async function fetchStats(): Promise<VaultStats> {
  const res = await fetch("/api/vault/index/stats");
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  return res.json();
}

async function fetchGraph(): Promise<GraphResponse> {
  const res = await fetch("/api/vault/index/graph");
  if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
  return res.json();
}

export function useBacklinks(path: string) {
  return useQuery({
    queryKey: ["index", "backlinks", path],
    queryFn: () => fetchBacklinks(path),
    enabled: !!path,
  });
}

export function useTags() {
  return useQuery({
    queryKey: ["index", "tags"],
    queryFn: fetchTags,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ["index", "stats"],
    queryFn: fetchStats,
  });
}

export function useGraph() {
  return useQuery({
    queryKey: ["index", "graph"],
    queryFn: fetchGraph,
  });
}
```

**Step 4: Verify typecheck**

```bash
cd ui && bun run typecheck
```

**Step 5: Commit**

```bash
git add ui/src/api/
git commit -m "feat(ui): add typed API client hooks for pages and index endpoints"
```

---

## Task 3: App shell layout (sidebar + content area)

Replace the placeholder layout with a two-panel design: collapsible sidebar on the left, content area on the right.

**Files:**
- Create: `ui/src/components/AppLayout.tsx`
- Create: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/routes/__root.tsx`

**Step 1: Create the AppLayout component**

Create `ui/src/components/AppLayout.tsx`:

```tsx
import type { ReactNode } from "react";
import { Sidebar } from "#/components/Sidebar";
import { SyncIndicator } from "#/components/SyncIndicator";
import { ThemeToggle } from "#/components/ThemeToggle";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-end gap-3 border-b border-border px-4 py-2">
          <SyncIndicator />
          <ThemeToggle className="inline-flex h-8 w-8 items-center justify-center border border-border bg-background text-foreground" />
        </header>
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
```

Design notes:
- Full-height flex layout, sidebar on left
- Header with border-bottom (hard edge, no radius)
- Content area scrolls independently

**Step 2: Create the Sidebar shell**

Create `ui/src/components/Sidebar.tsx`:

A collapsible sidebar with vault name, page list, and tags section. For now, just the structure — page list and tags will be populated in later tasks.

```tsx
import { Link } from "@tanstack/react-router";

export function Sidebar() {
  return (
    <aside className="flex w-64 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <Link to="/" className="text-sm font-bold uppercase tracking-widest text-foreground">
          clepsydra
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {/* PageList component will go here */}
        <p className="px-2 py-1 text-xs text-muted-foreground">Loading pages...</p>
      </nav>
      <div className="border-t border-border px-2 py-2">
        {/* Tags section will go here */}
      </div>
    </aside>
  );
}
```

**Step 3: Update root route**

Modify `ui/src/routes/__root.tsx` to use `AppLayout`:

```tsx
import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { AppLayout } from "#/components/AppLayout";

export const Route = createRootRoute({
  notFoundComponent: () => <div className="p-8">404 - Not Found</div>,
  head: () => ({
    meta: [{ title: "clepsydra" }],
  }),
  component: () => (
    <>
      <HeadContent />
      <AppLayout>
        <Outlet />
      </AppLayout>
    </>
  ),
});
```

**Step 4: Verify typecheck and dev server**

```bash
cd ui && bun run typecheck
```

Optionally start dev server to visually verify: `cd ui && bun run dev`

**Step 5: Commit**

```bash
git add ui/src/components/AppLayout.tsx ui/src/components/Sidebar.tsx ui/src/routes/__root.tsx
git commit -m "feat(ui): add two-panel app layout with sidebar shell"
```

---

## Task 4: Page list in sidebar

Populate the sidebar with the list of pages from `GET /api/vault/pages`, grouped into a simple folder tree.

**Files:**
- Create: `ui/src/components/PageList.tsx`
- Modify: `ui/src/components/Sidebar.tsx`

**Step 1: Create PageList component**

Create `ui/src/components/PageList.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { usePages } from "#/api/pages";

export function PageList() {
  const { data: pages, isLoading, error } = usePages();

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
    <ul className="space-y-px">
      {pages.map((page) => (
        <li key={page.id}>
          <Link
            to="/pages/$"
            params={{ _splat: page.path }}
            className="block truncate px-2 py-1 text-sm text-foreground hover:bg-accent"
            activeProps={{ className: "bg-accent font-medium" }}
          >
            {page.title || page.path}
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

Notes:
- Links to `/pages/$` splat route (created in Task 5)
- Shows title if available, falls back to path
- Active link gets `bg-accent` + bold
- Hard edges (no rounded corners) per design language

**Step 2: Wire into Sidebar**

Replace the placeholder `<p>` in `Sidebar.tsx` `<nav>` with `<PageList />`.

**Step 3: Verify typecheck**

```bash
cd ui && bun run typecheck
```

Note: The `/pages/$` route doesn't exist yet (Task 5), so the `Link` params may cause a type error. If so, create the route file as a stub first, or use `as any` temporarily and fix in Task 5. Alternatively, use a plain `<a>` tag here and convert to `<Link>` in Task 5.

**Step 4: Commit**

```bash
git add ui/src/components/PageList.tsx ui/src/components/Sidebar.tsx
git commit -m "feat(ui): add page list sidebar with API-driven navigation"
```

---

## Task 5: Page viewer route with markdown rendering

Create a route that displays a single page: rendered markdown body, frontmatter metadata, and wikilink navigation.

**Files:**
- Create: `ui/src/routes/pages/$.tsx`
- Create: `ui/src/components/MarkdownRenderer.tsx`
- Create: `ui/src/components/PageHeader.tsx`

**Step 1: Create MarkdownRenderer component**

Create `ui/src/components/MarkdownRenderer.tsx`:

```tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import wikiLinkPlugin from "remark-wiki-link";
import { useNavigate } from "@tanstack/react-router";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const navigate = useNavigate();

  return (
    <Markdown
      className={className}
      remarkPlugins={[
        remarkGfm,
        [wikiLinkPlugin, {
          hrefTemplate: (permalink: string) => `/pages/${permalink}`,
          aliasDivider: "|",
        }],
      ]}
      components={{
        // Style links: internal wikilinks navigate via router
        a: ({ href, children, ...props }) => {
          if (href?.startsWith("/pages/")) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ to: href });
                }}
                className="underline decoration-1 underline-offset-2 hover:decoration-2"
                {...props}
              >
                {children}
              </a>
            );
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-1 underline-offset-2 hover:decoration-2"
              {...props}
            >
              {children}
            </a>
          );
        },
        // Brutalist table styling
        table: ({ children, ...props }) => (
          <table className="w-full border-collapse border border-border" {...props}>
            {children}
          </table>
        ),
        th: ({ children, ...props }) => (
          <th className="border border-border bg-muted px-3 py-1.5 text-left text-sm font-bold" {...props}>
            {children}
          </th>
        ),
        td: ({ children, ...props }) => (
          <td className="border border-border px-3 py-1.5 text-sm" {...props}>
            {children}
          </td>
        ),
        // Code blocks
        pre: ({ children, ...props }) => (
          <pre className="overflow-x-auto border border-border bg-muted p-4 text-sm" {...props}>
            {children}
          </pre>
        ),
        code: ({ children, className: codeClassName, ...props }) => {
          // Inline code vs block code
          if (codeClassName) {
            return <code className={codeClassName} {...props}>{children}</code>;
          }
          return (
            <code className="bg-muted px-1 py-0.5 text-sm" {...props}>
              {children}
            </code>
          );
        },
        // Headings with IDs for anchor links
        h1: ({ children, ...props }) => (
          <h1 className="mb-4 mt-8 text-2xl font-bold" {...props}>{children}</h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 className="mb-3 mt-6 text-xl font-bold" {...props}>{children}</h2>
        ),
        h3: ({ children, ...props }) => (
          <h3 className="mb-2 mt-4 text-lg font-bold" {...props}>{children}</h3>
        ),
        // Blockquotes
        blockquote: ({ children, ...props }) => (
          <blockquote className="border-l-4 border-border pl-4 italic text-muted-foreground" {...props}>
            {children}
          </blockquote>
        ),
      }}
    />
  );
}
```

Design notes:
- No rounded corners anywhere (per brutalist aesthetic)
- Hard-edged borders on tables, code blocks
- Wikilinks navigate via TanStack Router
- External links open in new tab

**Step 2: Create PageHeader component**

Create `ui/src/components/PageHeader.tsx`:

```tsx
import type { PageMeta } from "#/api/types";

interface PageHeaderProps {
  title: string | null;
  path: string;
  meta: PageMeta;
}

export function PageHeader({ title, path, meta }: PageHeaderProps) {
  return (
    <div className="border-b border-border pb-4">
      <h1 className="text-2xl font-bold">{title || path}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{path}</p>
      {meta.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {meta.tags.map((tag) => (
            <span
              key={tag}
              className="border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Create page viewer route**

Create `ui/src/routes/pages/$.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { usePage } from "#/api/pages";
import { useBacklinks } from "#/api/index";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { PageHeader } from "#/components/PageHeader";
import { BacklinksPanel } from "#/components/BacklinksPanel";

export const Route = createFileRoute("/pages/$")({
  component: PageViewer,
});

function PageViewer() {
  const { _splat: path } = Route.useParams();
  const { data: page, isLoading, error } = usePage(path);
  const { data: backlinks } = useBacklinks(path);

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>;
  }
  if (error || !page) {
    return <div className="p-8 text-destructive">Page not found</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <PageHeader title={page.meta.title} path={page.path} meta={page.meta} />
      <article className="prose-brutalist mt-6">
        <MarkdownRenderer content={page.body} />
      </article>
      {backlinks && backlinks.length > 0 && (
        <BacklinksPanel backlinks={backlinks} />
      )}
    </div>
  );
}
```

Note: `BacklinksPanel` is created in Task 6. For this task, either:
- Import it and create a stub (empty component that returns null)
- Or omit the backlinks section and add it in Task 6

**Step 4: Verify typecheck and dev server**

```bash
cd ui && bun run typecheck
```

**Step 5: Create a Storybook story for MarkdownRenderer**

Create `ui/src/components/MarkdownRenderer.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { MarkdownRenderer } from "./MarkdownRenderer";

const meta = {
  title: "Components/MarkdownRenderer",
  component: MarkdownRenderer,
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BasicMarkdown: Story = {
  args: {
    content: `# Hello World

This is a paragraph with **bold** and *italic* text.

## Lists

- Item one
- Item two
- Item three

## Code

\`\`\`rust
fn main() {
    println!("hello");
}
\`\`\`

Inline \`code\` here.

## Table

| Name | Value |
|------|-------|
| One  | 1     |
| Two  | 2     |

## Links

A [[wikilink]] and an [external link](https://example.com).

> A blockquote.
`,
  },
};
```

Note: The wikilink plugin in Storybook may need a router context wrapper. If it causes issues, just test with regular markdown and skip wikilinks in stories.

**Step 6: Commit**

```bash
git add ui/src/routes/pages/ ui/src/components/MarkdownRenderer.tsx ui/src/components/PageHeader.tsx ui/src/components/MarkdownRenderer.stories.tsx
git commit -m "feat(ui): add page viewer route with markdown rendering and wikilink navigation"
```

---

## Task 6: Backlinks panel

Show backlinks at the bottom of the page viewer, with source page title, link text, and context snippet.

**Files:**
- Create: `ui/src/components/BacklinksPanel.tsx`

**Step 1: Create BacklinksPanel component**

Create `ui/src/components/BacklinksPanel.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import type { BacklinkEntry } from "#/api/types";

interface BacklinksPanelProps {
  backlinks: BacklinkEntry[];
}

export function BacklinksPanel({ backlinks }: BacklinksPanelProps) {
  if (backlinks.length === 0) return null;

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
        Backlinks ({backlinks.length})
      </h2>
      <ul className="space-y-3">
        {backlinks.map((bl, i) => (
          <li key={`${bl.source_id}-${i}`} className="border border-border p-3">
            <Link
              to="/pages/$"
              params={{ _splat: bl.source_path }}
              className="font-medium underline decoration-1 underline-offset-2 hover:decoration-2"
            >
              {bl.source_title || bl.source_path}
            </Link>
            {bl.context && (
              <p className="mt-1 text-sm text-muted-foreground">{bl.context}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Design notes:
- Hard-edged border cards (no radius)
- Uppercase section heading with letter-spacing (brutalist typography)
- Context snippet in muted foreground
- Clicking navigates to the source page

**Step 2: Wire into page viewer**

If not already done in Task 5, import and add `<BacklinksPanel>` to the page viewer route.

**Step 3: Verify typecheck**

```bash
cd ui && bun run typecheck
```

**Step 4: Commit**

```bash
git add ui/src/components/BacklinksPanel.tsx
git commit -m "feat(ui): add backlinks panel to page viewer"
```

---

## Task 7: Vault dashboard on index route

Replace the placeholder `Hello "/"!` with a dashboard showing vault stats, recent pages, and tag cloud.

**Files:**
- Modify: `ui/src/routes/index.tsx`
- Create: `ui/src/components/StatCard.tsx`
- Create: `ui/src/components/TagCloud.tsx`

**Step 1: Create StatCard component**

Create `ui/src/components/StatCard.tsx`:

```tsx
interface StatCardProps {
  label: string;
  value: number;
}

export function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="border border-border p-4 shadow-sm">
      <p className="text-3xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
    </div>
  );
}
```

**Step 2: Create TagCloud component**

Create `ui/src/components/TagCloud.tsx`:

```tsx
import type { TagCount } from "#/api/types";

interface TagCloudProps {
  tags: TagCount[];
}

export function TagCloud({ tags }: TagCloudProps) {
  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t.tag}
          className="border border-border px-2 py-0.5 text-xs"
        >
          {t.tag}
          <span className="ml-1 text-muted-foreground">{t.count}</span>
        </span>
      ))}
    </div>
  );
}
```

**Step 3: Update index route**

Modify `ui/src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useStats } from "#/api/index";
import { useTags } from "#/api/index";
import { usePages } from "#/api/pages";
import { StatCard } from "#/components/StatCard";
import { TagCloud } from "#/components/TagCloud";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const { data: stats } = useStats();
  const { data: tags } = useTags();
  const { data: pages } = usePages();

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <h1 className="mb-6 text-2xl font-bold">Vault</h1>

      {stats && (
        <div className="mb-8 grid grid-cols-3 gap-4">
          <StatCard label="Pages" value={stats.pages} />
          <StatCard label="Links" value={stats.links_total} />
          <StatCard label="Tags" value={stats.tags} />
        </div>
      )}

      {stats && stats.links_unresolved > 0 && (
        <div className="mb-8 border border-destructive p-4">
          <p className="text-sm font-bold text-destructive">
            {stats.links_unresolved} unresolved link{stats.links_unresolved !== 1 ? "s" : ""}
          </p>
        </div>
      )}

      {tags && tags.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
            Tags
          </h2>
          <TagCloud tags={tags} />
        </section>
      )}

      {pages && pages.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
            All Pages ({pages.length})
          </h2>
          <ul className="space-y-px">
            {pages.slice(0, 20).map((p) => (
              <li key={p.id}>
                <a
                  href={`/pages/${p.path}`}
                  className="block border-b border-border px-2 py-2 text-sm hover:bg-accent"
                >
                  <span className="font-medium">{p.title || p.path}</span>
                  {p.title && (
                    <span className="ml-2 text-xs text-muted-foreground">{p.path}</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
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
git add ui/src/routes/index.tsx ui/src/components/StatCard.tsx ui/src/components/TagCloud.tsx
git commit -m "feat(ui): add vault dashboard with stats, tags, and page list"
```

---

## Task 8: Tags section in sidebar + Storybook stories

Add a compact tag list to the sidebar footer and create Storybook stories for the key new components.

**Files:**
- Modify: `ui/src/components/Sidebar.tsx`
- Create: `ui/src/components/StatCard.stories.tsx`
- Create: `ui/src/components/TagCloud.stories.tsx`
- Create: `ui/src/components/BacklinksPanel.stories.tsx`

**Step 1: Add tags to sidebar**

In `ui/src/components/Sidebar.tsx`, import `useTags` and render a compact tag list in the footer section:

```tsx
import { useTags } from "#/api/index";

// In the footer div:
const { data: tags } = useTags();

// Render:
{tags && tags.length > 0 && (
  <>
    <p className="mb-1 px-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
      Tags
    </p>
    <ul className="space-y-px">
      {tags.slice(0, 15).map((t) => (
        <li key={t.tag} className="flex items-center justify-between px-2 py-0.5 text-xs">
          <span>{t.tag}</span>
          <span className="text-muted-foreground">{t.count}</span>
        </li>
      ))}
    </ul>
  </>
)}
```

**Step 2: Create Storybook stories**

Create stories for StatCard, TagCloud, and BacklinksPanel with representative data. These are pure presentational components — no router context needed (except BacklinksPanel which uses `<Link>`; wrap it in a memory router for Storybook or use a decorator).

**Step 3: Verify typecheck and Storybook**

```bash
cd ui && bun run typecheck
cd ui && bun run build-storybook
```

**Step 4: Commit**

```bash
git add ui/src/components/Sidebar.tsx ui/src/components/StatCard.stories.tsx ui/src/components/TagCloud.stories.tsx ui/src/components/BacklinksPanel.stories.tsx
git commit -m "feat(ui): add tags to sidebar and Storybook stories for new components"
```

---

## Task 9: Biome lint + format pass and final verification

Run the full lint/format cycle and fix any issues.

**Files:**
- Potentially any `ui/src/` file

**Step 1: Format and lint**

```bash
cd ui && bun run format
cd ui && bun run lint
```

**Step 2: Typecheck**

```bash
cd ui && bun run typecheck
```

**Step 3: Build**

```bash
cd ui && bun run build
```

This runs `tsc -b && vite build` — catches both type errors and build-time issues.

**Step 4: Run backend tests to ensure no regressions**

```bash
cargo test
```

**Step 5: Commit any lint/format fixes**

```bash
git add -A ui/src/
git commit -m "style(ui): apply biome formatting to new components"
```

---

## Dependency Graph

```
Task 1 (deps) ─→ Task 2 (API hooks) ─→ Task 3 (layout)
                                          ├─→ Task 4 (page list)
                                          └─→ Task 7 (dashboard)
                  Task 2 ─→ Task 5 (page viewer) ─→ Task 6 (backlinks)
                  Task 2 ─→ Task 8 (tags sidebar + stories)
                  All tasks ─→ Task 9 (lint + verify)
```

Tasks 4, 5, 7, and 8 can proceed in parallel after Tasks 2 and 3 are complete.

---

## Notes for Implementer

1. **`react-markdown` + `remark-wiki-link` integration**: The `remark-wiki-link` plugin may have TypeScript type issues with `react-markdown` v10. If types don't align, use `// @ts-expect-error` on the plugin array entry or cast as needed. The functionality works regardless.

2. **TanStack Router splat routes**: The file `ui/src/routes/pages/$.tsx` creates a catch-all route. Access the path via `Route.useParams()._splat`. The splat captures everything after `/pages/`, including nested paths like `library/papers/foo.md`.

3. **`encodeURI` for API calls**: Page paths may contain special characters. Use `encodeURI(path)` when constructing fetch URLs (not `encodeURIComponent`, which would double-encode slashes).

4. **Design language reminders**:
   - Zero border-radius everywhere (no `rounded-*` classes)
   - Hard-edged offset shadows (`shadow-sm` through `shadow-xl`)
   - Achromatic palette — use semantic color tokens from `main.css`
   - Uppercase + tracking-widest for section labels
   - Borders on cards, not just shadows

5. **SSE invalidation**: The existing `useVaultEvents` hook already invalidates `["pages"]` and `["index"]` query keys on `index_changed` events. The new hooks automatically benefit from this — no additional wiring needed.

6. **Storybook with TanStack Router**: Components using `<Link>` need a router context. Either wrap stories in a `createMemoryHistory` router, or use plain `<a>` tags in Storybook-facing props. The `MarkdownRenderer` component uses `useNavigate` — stories for it need a router decorator.

7. **`throwOnError: true` on QueryClient**: The existing query client throws on error. Components should be wrapped in error boundaries, or individual queries can override with `throwOnError: false`. For this phase, the default is fine — TanStack Router's error boundaries catch thrown errors.
