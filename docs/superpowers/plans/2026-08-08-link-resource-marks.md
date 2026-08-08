# Link Resource Marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gwern-style decorative marks to a curated set of external resource links in Markdown, Slate, hover previews, and MDX documentation.

**Architecture:** A pure ordered TypeScript registry classifies parsed HTTP(S) URLs by exact host boundary and then by pathname extension. React renderers emit a typed `data-link-resource` attribute; shared CSS renders local monochrome SVG masks without adding editable or accessible text.

**Tech Stack:** TypeScript, React 19, Slate, react-markdown, MDX, Tailwind/CSS, Vitest, Testing Library, Storybook, Vite.

## Global Constraints

- Stored Markdown, Slate values, copied text, selection text, accessible names, and navigation behavior must not change.
- Only `http:` and `https:` URLs are classifiable; malformed, relative, internal, scheme, `mailto:`, and unsupported links return `null`.
- Host matching means exact equality or `hostname.endsWith("." + domain)` only for rules that explicitly permit subdomains.
- Specific services outrank generic file types.
- The fixed resource union and domain/extension table come from `docs/superpowers/specs/2026-08-08-link-resource-marks-design.md`.
- Marks use local monochrome SVG masks, `currentColor`, `0.65em` default dimensions, `0.18em` inline-start margin, and `0.6` resting opacity.
- Every SVG contains `<metadata>` with source URL, license, and copied/adapted/original status.
- No brand colors, `!W` authoring support, stored-link rewriting, per-link overrides, link previews, or new runtime dependency.
- Path alias `#/` means `ui/src/`. Biome uses 2-space indentation and double quotes.
- Preserve unrelated work in the dirty worktree. Stage and commit only files named by the current task.

---

## File map

### Create

- `ui/src/lib/linkResource.ts` — pure resource type, ordered host rules, generic file rules, and classifier.
- `ui/src/lib/linkResource.test.ts` — URL boundary, protocol, precedence, and extension contracts.
- `ui/src/editor/elements/LinkElement.test.tsx` — editable-link metadata and text-content contracts.
- `ui/src/components/codex/PreviewMarkdown.test.tsx` — compact non-interactive link metadata contract.
- `ui/src/assets/link-marks/wikipedia.svg`
- `ui/src/assets/link-marks/arxiv.svg`
- `ui/src/assets/link-marks/biorxiv.svg`
- `ui/src/assets/link-marks/doi.svg`
- `ui/src/assets/link-marks/pubmed.svg`
- `ui/src/assets/link-marks/semantic-scholar.svg`
- `ui/src/assets/link-marks/github.svg`
- `ui/src/assets/link-marks/gitlab.svg`
- `ui/src/assets/link-marks/internet-archive.svg`
- `ui/src/assets/link-marks/youtube.svg`
- `ui/src/assets/link-marks/vimeo.svg`
- `ui/src/assets/link-marks/pdf.svg`
- `ui/src/assets/link-marks/audio.svg`
- `ui/src/assets/link-marks/video.svg`
- `ui/src/assets/link-marks/image.svg`

### Modify

- `ui/src/components/MarkdownRenderer.tsx` — annotate rendered external Markdown anchors.
- `ui/src/components/MarkdownRenderer.test.tsx` — Markdown resource metadata and accessible-name tests.
- `ui/src/components/MarkdownRenderer.stories.tsx` — complete visual catalog and wrapping fixtures.
- `ui/src/editor/elements/LinkElement.tsx` — annotate the existing Slate anchor only.
- `ui/src/components/codex/PreviewMarkdown.tsx` — classify from `href` and annotate the existing non-interactive span.
- `ui/src/components/docs/DocsMdxComponents.tsx` — replace generic external arrow with a recognized mark.
- `ui/src/components/docs/__tests__/DocsArticle.test.tsx` — docs mark/arrow routing contract.
- `ui/src/main.css` — shared mark box, interaction states, and per-resource mask mapping.

---

### Task 1: Typed URL resource classifier

**Files:**
- Create: `ui/src/lib/linkResource.ts`
- Create: `ui/src/lib/linkResource.test.ts`

**Interfaces:**
- Consumes: standard `URL` parsing only.
- Produces: `LinkResource` and `classifyLinkResource(href: string): LinkResource | null` for every renderer task.

- [ ] **Step 1: Write the failing classifier tests**

Create `ui/src/lib/linkResource.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyLinkResource } from "#/lib/linkResource";

describe("classifyLinkResource", () => {
  it.each([
    ["https://en.wikipedia.org/wiki/Hypertext", "wikipedia"],
    ["https://commons.wikimedia.org/wiki/File:Example.svg", "wikipedia"],
    ["https://foundation.wikimedia.org/wiki/Policy", "wikipedia"],
    ["https://en.wiktionary.org/wiki/link", "wikipedia"],
    ["https://arxiv.org/pdf/2401.00001.pdf", "arxiv"],
    ["https://www.biorxiv.org/content/10.1101/2025.01.01.000001", "biorxiv"],
    ["https://www.medrxiv.org/content/10.1101/2025.01.01.000001", "biorxiv"],
    ["https://doi.org/10.1000/example", "doi"],
    ["https://pubmed.ncbi.nlm.nih.gov/12345678/", "pubmed"],
    ["https://pmc.ncbi.nlm.nih.gov/articles/PMC123/", "pubmed"],
    ["https://www.semanticscholar.org/paper/example", "semantic-scholar"],
    ["https://github.com/example/project", "github"],
    ["https://raw.githubusercontent.com/example/project/main/file.ts", "github"],
    ["https://gitlab.com/example/project", "gitlab"],
    ["https://web.archive.org/web/20200101/https://example.com", "internet-archive"],
    ["https://www.youtube.com/watch?v=abc", "youtube"],
    ["https://youtu.be/abc", "youtube"],
    ["https://player.vimeo.com/video/123", "vimeo"],
    ["https://example.com/paper.PDF?download=1#page=2", "pdf"],
    ["https://example.com/audio.flac", "audio"],
    ["https://example.com/movie.webm", "video"],
    ["https://example.com/figure.avif", "image"],
  ])("classifies %s as %s", (href, expected) => {
    expect(classifyLinkResource(href)).toBe(expected);
  });

  it.each([
    "notes/local.md",
    "/pages/notes/local.md",
    "#section",
    "mailto:person@example.com",
    "clepsydra://page/123",
    "javascript:alert(1)",
    "not a url",
    "https://example.com/page",
    "https://wikipedia.org.example.com/wiki/Fake",
    "https://github.com.example.com/project",
    "https://ncbi.nlm.nih.gov/",
    "https://example.com/file.pdf.exe",
  ])("does not classify %s", (href) => {
    expect(classifyLinkResource(href)).toBeNull();
  });

  it("normalizes protocol and hostname case", () => {
    expect(classifyLinkResource("HTTPS://EN.WIKIPEDIA.ORG/wiki/Test")).toBe(
      "wikipedia",
    );
  });

  it("gives service identity precedence over file type", () => {
    expect(classifyLinkResource("https://github.com/example/paper.pdf")).toBe(
      "github",
    );
  });
});
```

- [ ] **Step 2: Run the classifier test red**

Run:

```bash
bun --cwd ui run test -- src/lib/linkResource.test.ts
```

Expected: FAIL because `#/lib/linkResource` does not exist.

- [ ] **Step 3: Implement the ordered pure classifier**

Create `ui/src/lib/linkResource.ts` with this structure and fixed data:

```ts
export const LINK_RESOURCES = [
  "wikipedia",
  "arxiv",
  "biorxiv",
  "doi",
  "pubmed",
  "semantic-scholar",
  "github",
  "gitlab",
  "internet-archive",
  "youtube",
  "vimeo",
  "pdf",
  "audio",
  "video",
  "image",
] as const;

export type LinkResource = (typeof LINK_RESOURCES)[number];

type HostRule = {
  resource: LinkResource;
  domains: readonly string[];
  includeSubdomains: boolean;
};

const HOST_RULES: readonly HostRule[] = [
  {
    resource: "wikipedia",
    domains: [
      "wikipedia.org",
      "wikimedia.org",
      "wikimediafoundation.org",
      "wiktionary.org",
      "wikisource.org",
      "wikibooks.org",
      "wikiquote.org",
      "mediawiki.org",
    ],
    includeSubdomains: true,
  },
  { resource: "arxiv", domains: ["arxiv.org"], includeSubdomains: true },
  {
    resource: "biorxiv",
    domains: ["biorxiv.org", "medrxiv.org"],
    includeSubdomains: true,
  },
  { resource: "doi", domains: ["doi.org"], includeSubdomains: true },
  {
    resource: "pubmed",
    domains: ["pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"],
    includeSubdomains: false,
  },
  {
    resource: "semantic-scholar",
    domains: ["semanticscholar.org"],
    includeSubdomains: true,
  },
  {
    resource: "github",
    domains: ["github.com", "githubusercontent.com"],
    includeSubdomains: true,
  },
  { resource: "gitlab", domains: ["gitlab.com"], includeSubdomains: true },
  {
    resource: "internet-archive",
    domains: ["archive.org"],
    includeSubdomains: true,
  },
  {
    resource: "youtube",
    domains: ["youtube.com"],
    includeSubdomains: true,
  },
  {
    resource: "youtube",
    domains: ["youtu.be"],
    includeSubdomains: false,
  },
  { resource: "vimeo", domains: ["vimeo.com"], includeSubdomains: true },
];

const EXTENSION_RULES: readonly [LinkResource, readonly string[]][] = [
  ["pdf", [".pdf"]],
  ["audio", [".mp3", ".flac", ".ogg", ".wav", ".m4a"]],
  ["video", [".mp4", ".webm", ".mkv", ".mov", ".avi"]],
  ["image", [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]],
];

function matchesHost(
  hostname: string,
  domain: string,
  includeSubdomains: boolean,
): boolean {
  return (
    hostname === domain ||
    (includeSubdomains && hostname.endsWith(`.${domain}`))
  );
}

export function classifyLinkResource(href: string): LinkResource | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase();
  for (const rule of HOST_RULES) {
    if (
      rule.domains.some((domain) =>
        matchesHost(hostname, domain, rule.includeSubdomains),
      )
    ) {
      return rule.resource;
    }
  }

  const pathname = url.pathname.toLowerCase();
  for (const [resource, extensions] of EXTENSION_RULES) {
    if (extensions.some((extension) => pathname.endsWith(extension))) {
      return resource;
    }
  }

  return null;
}
```

Do not export the rule arrays; renderers depend only on the public type and function.

- [ ] **Step 4: Run focused tests and typecheck green**

Run:

```bash
bun --cwd ui run test -- src/lib/linkResource.test.ts
bun --cwd ui run typecheck
```

Expected: classifier suite PASS; typecheck exits 0.

- [ ] **Step 5: Commit the classifier**

```bash
git add ui/src/lib/linkResource.ts ui/src/lib/linkResource.test.ts
git commit -m "feat(ui): classify external link resources"
```

---

### Task 2: Markdown and compact-preview metadata

**Files:**
- Modify: `ui/src/components/MarkdownRenderer.tsx:1-83`
- Modify: `ui/src/components/MarkdownRenderer.test.tsx`
- Modify: `ui/src/components/codex/PreviewMarkdown.tsx:1-65`
- Create: `ui/src/components/codex/PreviewMarkdown.test.tsx`

**Interfaces:**
- Consumes: `classifyLinkResource(href: string): LinkResource | null` from Task 1.
- Produces: `data-link-resource` on external Markdown anchors and non-interactive preview spans.

- [ ] **Step 1: Add failing Markdown renderer tests**

Append before line 33, the closing line of the existing `MarkdownRenderer` describe block:

```tsx
it("marks recognized external resources without changing their accessible name", () => {
  render(
    <MarkdownRenderer
      content={
        "[Wikipedia](https://en.wikipedia.org/wiki/Hypertext) and [ordinary](https://example.com)"
      }
    />,
  );

  const wikipedia = screen.getByRole("link", { name: "Wikipedia" });
  expect(wikipedia).toHaveAttribute("data-link-resource", "wikipedia");
  expect(wikipedia).toHaveTextContent("Wikipedia");
  expect(screen.getByRole("link", { name: "ordinary" })).not.toHaveAttribute(
    "data-link-resource",
  );
});

it("does not mark internal page links", () => {
  render(<MarkdownRenderer content="[Local](/pages/notes/local.md)" />);
  expect(screen.getByRole("link", { name: "Local" })).not.toHaveAttribute(
    "data-link-resource",
  );
});
```

- [ ] **Step 2: Add the failing compact-preview test**

Create `ui/src/components/codex/PreviewMarkdown.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreviewMarkdown } from "#/components/codex/PreviewMarkdown";

describe("PreviewMarkdown", () => {
  it("marks a recognized resource while keeping preview links non-interactive", () => {
    render(
      <PreviewMarkdown
        content="[Wikipedia](https://en.wikipedia.org/wiki/Hypertext)"
      />,
    );

    const text = screen.getByText("Wikipedia");
    expect(text.tagName).toBe("SPAN");
    expect(text).toHaveAttribute("data-link-resource", "wikipedia");
    expect(screen.queryByRole("link", { name: "Wikipedia" })).toBeNull();
  });
});
```

- [ ] **Step 3: Run both renderer files red**

```bash
bun --cwd ui run test -- src/components/MarkdownRenderer.test.tsx src/components/codex/PreviewMarkdown.test.tsx
```

Expected: FAIL because neither renderer emits `data-link-resource`.

- [ ] **Step 4: Annotate Markdown anchors**

Import the classifier in `MarkdownRenderer.tsx`:

```ts
import { classifyLinkResource } from "#/lib/linkResource";
```

At the start of the existing `a` renderer, compute once:

```tsx
a: ({ href, children, ...props }) => {
  const resource = href ? classifyLinkResource(href) : null;
```

Keep the internal `/pages/` branch unchanged. Add this prop to the external `<a>` only:

```tsx
data-link-resource={resource ?? undefined}
```

Do not add a child node or change `target`, `rel`, classes, or click handling.

- [ ] **Step 5: Annotate non-interactive preview spans**

Import the classifier in `PreviewMarkdown.tsx`, then replace its current `a` renderer with:

```tsx
a: ({ href, children }) => {
  const resource = href ? classifyLinkResource(href) : null;
  return (
    <span
      className="text-accent underline decoration-1 underline-offset-2"
      data-link-resource={resource ?? undefined}
    >
      {children}
    </span>
  );
},
```

Do not render `href`, an anchor, click handling, or image/network behavior in previews.

- [ ] **Step 6: Run focused tests and typecheck green**

```bash
bun --cwd ui run test -- src/components/MarkdownRenderer.test.tsx src/components/codex/PreviewMarkdown.test.tsx
bun --cwd ui run typecheck
```

Expected: both suites PASS; typecheck exits 0.

- [ ] **Step 7: Commit both rendering paths**

```bash
git add ui/src/components/MarkdownRenderer.tsx ui/src/components/MarkdownRenderer.test.tsx ui/src/components/codex/PreviewMarkdown.tsx ui/src/components/codex/PreviewMarkdown.test.tsx
git commit -m "feat(ui): mark resources in markdown links"
```

---

### Task 3: Slate editable-link metadata

**Files:**
- Modify: `ui/src/editor/elements/LinkElement.tsx:22-133`
- Create: `ui/src/editor/elements/LinkElement.test.tsx`

**Interfaces:**
- Consumes: `classifyLinkResource(href: string): LinkResource | null` from Task 1.
- Produces: resource metadata on the existing editable anchor with no extra DOM text.

- [ ] **Step 1: Write failing Slate element tests**

Create `ui/src/editor/elements/LinkElement.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import type { RenderElementProps } from "slate-react";
import { describe, expect, it, vi } from "vitest";
import { LinkElement } from "#/editor/elements/LinkElement";
import type { LinkElement as LinkElementType } from "#/editor/types";

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => vi.fn(),
}));

const attributes = {
  "data-slate-node": "element",
  "data-slate-inline": true,
  ref: () => {},
} as unknown as RenderElementProps["attributes"];

function renderLink(url: string) {
  const element: LinkElementType = {
    type: "link",
    url,
    children: [{ text: "Wikipedia" }],
  };
  render(
    <LinkElement attributes={attributes} element={element}>
      Wikipedia
    </LinkElement>,
  );
  return screen.getByText("Wikipedia");
}

describe("LinkElement resource marks", () => {
  it("marks a recognized URL without adding editable or accessible text", () => {
    const link = renderLink("https://en.wikipedia.org/wiki/Hypertext");
    expect(link).toHaveAttribute("data-link-resource", "wikipedia");
    expect(link).toHaveTextContent(/^Wikipedia$/);
    expect(link.childNodes).toHaveLength(1);
  });

  it("does not mark a vault-relative link", () => {
    const link = renderLink("notes/local.md");
    expect(link).not.toHaveAttribute("data-link-resource");
    expect(link).not.toHaveAttribute("href");
  });
});
```

The discriminant is exactly `type: "link"` in `ui/src/editor/schema/types.ts`; keep the fixture type-checked against `LinkElementType`.

- [ ] **Step 2: Run the Slate test red**

```bash
bun --cwd ui run test -- src/editor/elements/LinkElement.test.tsx
```

Expected: recognized anchor lacks `data-link-resource`.

- [ ] **Step 3: Annotate the existing Slate anchor**

Import the classifier:

```ts
import { classifyLinkResource } from "#/lib/linkResource";
```

Compute the resource next to `safeHref`:

```ts
const safeHref = isExternal(url) ? url : undefined;
const resource = safeHref ? classifyLinkResource(safeHref) : null;
```

Add only this anchor prop:

```tsx
data-link-resource={resource ?? undefined}
```

Do not add `contentEditable={false}`, an icon component, a wrapper, or another child. Preserve the Slate/floating-ui ref composition and all click, hover, open, and copy behavior.

- [ ] **Step 4: Run focused editor tests and typecheck green**

```bash
bun --cwd ui run test -- src/editor/elements/LinkElement.test.tsx src/editor/__tests__/schemeLinks.test.ts
bun --cwd ui run typecheck
```

Expected: both suites PASS; typecheck exits 0.

- [ ] **Step 5: Commit the Slate integration**

```bash
git add ui/src/editor/elements/LinkElement.tsx ui/src/editor/elements/LinkElement.test.tsx
git commit -m "feat(ui): mark resources in editor links"
```

---

### Task 4: Documentation-link replacement behavior

**Files:**
- Modify: `ui/src/components/docs/DocsMdxComponents.tsx:9-123`
- Modify: `ui/src/components/docs/__tests__/DocsArticle.test.tsx:17-148`

**Interfaces:**
- Consumes: `classifyLinkResource(href: string): LinkResource | null` from Task 1.
- Produces: marked recognized docs anchors; `↗` remains only on unsupported external anchors.

- [ ] **Step 1: Extend the docs fixture and write failing assertions**

In `FixtureGuide`, add a recognized external anchor after the existing ordinary external anchor:

```tsx
{" · "}
<Anchor href="https://en.wikipedia.org/wiki/Hypertext">Wikipedia</Anchor>
```

In `routes docs links internally while preserving fragments and external safety`, add:

```tsx
const ordinaryExternal = screen.getByRole("link", { name: "External" });
expect(ordinaryExternal).not.toHaveAttribute("data-link-resource");
expect(ordinaryExternal).toHaveTextContent("↗");

const wikipedia = screen.getByRole("link", { name: "Wikipedia" });
expect(wikipedia).toHaveAttribute("data-link-resource", "wikipedia");
expect(wikipedia).not.toHaveTextContent("↗");
expect(wikipedia).toHaveAttribute("target", "_blank");
expect(wikipedia).toHaveAttribute("rel", "noreferrer");
```

Keep the pre-existing external-link queries at accessible name `"External"`: the existing arrow is `aria-hidden` and therefore does not contribute to the name.

- [ ] **Step 2: Run the docs suite red**

```bash
bun --cwd ui run test -- src/components/docs/__tests__/DocsArticle.test.tsx
```

Expected: Wikipedia lacks resource metadata and still contains `↗`.

- [ ] **Step 3: Classify once in the external docs branch**

Import the classifier:

```ts
import { classifyLinkResource } from "#/lib/linkResource";
```

Inside `if (/^https?:\/\//i.test(href))`, compute and render:

```tsx
const resource = classifyLinkResource(href);
return (
  <a
    {...props}
    href={href}
    target="_blank"
    rel="noreferrer"
    className={classes}
    data-link-resource={resource ?? undefined}
  >
    {children}
    {!resource && (
      <span aria-hidden="true" className="ml-1 font-mono text-xs">
        ↗
      </span>
    )}
  </a>
);
```

Preserve internal TanStack Router handling, fragment handling, prop spread order, and external safety attributes.

- [ ] **Step 4: Run focused docs tests and typecheck green**

```bash
bun --cwd ui run test -- src/components/docs/__tests__/DocsArticle.test.tsx
bun --cwd ui run typecheck
```

Expected: docs suite PASS; typecheck exits 0.

- [ ] **Step 5: Commit docs behavior**

```bash
git add ui/src/components/docs/DocsMdxComponents.tsx ui/src/components/docs/__tests__/DocsArticle.test.tsx
git commit -m "feat(ui): mark resources in documentation links"
```

---

### Task 5: SVG masks, shared CSS, and visual catalog

**Files:**
- Create: all 15 files under `ui/src/assets/link-marks/` listed in the file map.
- Modify: `ui/src/main.css:479-490`
- Modify: `ui/src/components/MarkdownRenderer.stories.tsx`

**Interfaces:**
- Consumes: the exact `LinkResource` string values emitted by Tasks 1–4.
- Produces: one decorative CSS mask per value and a Storybook matrix for browser verification.

- [ ] **Step 1: Source and normalize the 15 SVGs**

Use these fixed sources and licenses; do not add an icon package:

| Asset | Source | License/provenance |
| --- | --- | --- |
| `wikipedia.svg` | Font Awesome `wikipedia-w` | Font Awesome Free Brands, CC BY 4.0 |
| `arxiv.svg` | Simple Icons `arXiv` | Simple Icons, CC0 1.0; brand trademark noted |
| `biorxiv.svg` | Simple Icons `bioRxiv` | Simple Icons, CC0 1.0; brand trademark noted |
| `doi.svg` | Simple Icons `DOI` | Simple Icons, CC0 1.0; brand trademark noted |
| `pubmed.svg` | Wikimedia Commons `US-NLM-NCBI-Logo.svg`, reduced to the NCBI/NLM letterform | U.S. government work/public-domain status recorded from source page |
| `semantic-scholar.svg` | Simple Icons `Semantic Scholar` | Simple Icons, CC0 1.0; brand trademark noted |
| `github.svg` | Simple Icons `GitHub` | Simple Icons, CC0 1.0; brand trademark noted |
| `gitlab.svg` | Simple Icons `GitLab` | Simple Icons, CC0 1.0; brand trademark noted |
| `internet-archive.svg` | Simple Icons `Internet Archive` | Simple Icons, CC0 1.0; brand trademark noted |
| `youtube.svg` | Simple Icons `YouTube` | Simple Icons, CC0 1.0; brand trademark noted |
| `vimeo.svg` | Simple Icons `Vimeo` | Simple Icons, CC0 1.0; brand trademark noted |
| `pdf.svg` | Lucide `file-text` reduced to the page silhouette | Lucide, ISC |
| `audio.svg` | Lucide `audio-lines` | Lucide, ISC |
| `video.svg` | Lucide `video` | Lucide, ISC |
| `image.svg` | Lucide `image` | Lucide, ISC |

Canonical source pages:

```text
https://fontawesome.com/icons/wikipedia-w?f=brands&s=solid
https://simpleicons.org/
https://commons.wikimedia.org/wiki/File:US-NLM-NCBI-Logo.svg
https://lucide.dev/icons/file-text
https://lucide.dev/icons/audio-lines
https://lucide.dev/icons/video
https://lucide.dev/icons/image
```

Normalize each file to one view box and mask-compatible black geometry. Put provenance inside every SVG. For example, `wikipedia.svg` is the complete Font Awesome Wikipedia-W geometry plus its provenance:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512">
  <metadata>Source: https://fontawesome.com/icons/wikipedia-w?f=brands&amp;s=solid; icon: Wikipedia W; license: CC-BY-4.0; copied for Clepsydra; Wikipedia trademarks remain property of their owners.</metadata>
  <path d="M640 51.2l-.3 12.2c-28.1.8-45 15.8-55.8 40.3-25 57.8-103.3 240-155.3 358.6H415l-81.9-193.1c-32.5 63.6-68.3 130-99.2 193.1-.3.3-15 0-15-.3C172 352.3 122.8 243.4 75.8 133.4 64.4 106.7 26.4 63.4.2 63.7c0-3.1-.3-10-.3-14.2h161.9v13.9c-19.2 1.1-52.8 13.3-43.3 34.2 21.9 49.7 103.6 240.3 125.6 288.6 15-29.7 57.8-109.2 75.3-142.8-13.9-28.3-58.6-133.9-72.8-160-9.7-17.8-36.1-19.4-55.8-19.7V49.8l142.5.3v13.1c-19.4.6-38.1 7.8-29.4 26.1 18.9 40 30.6 68.1 48.1 104.7 5.6-10.8 34.7-69.4 48.1-100.8 8.9-20.6-3.9-28.6-38.6-29.4.3-3.6 0-10.3.3-13.6 44.4-.3 111.1-.3 123.1-.6v13.6c-22.5.8-45.8 12.8-58.1 31.7l-59.2 122.8c6.4 16.1 63.3 142.8 69.2 156.7L559.2 91.8c-8.6-23.1-36.4-28.1-47.2-28.3V49.6l127.8 1.1.2.5z" />
</svg>
```

For the remaining files, preserve the exact path or stroke geometry supplied by the named source and add metadata with that table row's source, icon name, license, and copied/adapted status.

For stroke-based Lucide sources, preserve `fill="none"`, `stroke="black"`, `stroke-width="2"`, `stroke-linecap="round"`, and `stroke-linejoin="round"`; the CSS mask uses stroke alpha correctly. Do not include scripts, styles, external image references, embedded raster data, brand colors, fixed pixel width, or fixed pixel height.

- [ ] **Step 2: Add the shared mark box and interaction styles**

Append after the existing `.cl-link:hover` block in `ui/src/main.css`:

```css
[data-link-resource]::after {
    content: "";
    display: inline-block;
    width: var(--link-resource-size, 0.65em);
    height: var(--link-resource-size, 0.65em);
    margin-inline-start: var(--link-resource-gap, 0.18em);
    vertical-align: var(--link-resource-align, -0.05em);
    background-color: currentColor;
    opacity: var(--link-resource-opacity, 0.6);
    pointer-events: none;
    -webkit-mask: var(--link-resource-mask) center / contain no-repeat;
    mask: var(--link-resource-mask) center / contain no-repeat;
}

[data-link-resource]:is(:hover, :focus-visible)::after {
    opacity: 1;
}

[data-link-resource="wikipedia"] {
    --link-resource-mask: url("./assets/link-marks/wikipedia.svg");
}
[data-link-resource="arxiv"] {
    --link-resource-mask: url("./assets/link-marks/arxiv.svg");
}
[data-link-resource="biorxiv"] {
    --link-resource-mask: url("./assets/link-marks/biorxiv.svg");
}
[data-link-resource="doi"] {
    --link-resource-mask: url("./assets/link-marks/doi.svg");
}
[data-link-resource="pubmed"] {
    --link-resource-mask: url("./assets/link-marks/pubmed.svg");
}
[data-link-resource="semantic-scholar"] {
    --link-resource-mask: url("./assets/link-marks/semantic-scholar.svg");
}
[data-link-resource="github"] {
    --link-resource-mask: url("./assets/link-marks/github.svg");
}
[data-link-resource="gitlab"] {
    --link-resource-mask: url("./assets/link-marks/gitlab.svg");
}
[data-link-resource="internet-archive"] {
    --link-resource-mask: url("./assets/link-marks/internet-archive.svg");
}
[data-link-resource="youtube"] {
    --link-resource-mask: url("./assets/link-marks/youtube.svg");
}
[data-link-resource="vimeo"] {
    --link-resource-mask: url("./assets/link-marks/vimeo.svg");
}
[data-link-resource="pdf"] {
    --link-resource-mask: url("./assets/link-marks/pdf.svg");
}
[data-link-resource="audio"] {
    --link-resource-mask: url("./assets/link-marks/audio.svg");
}
[data-link-resource="video"] {
    --link-resource-mask: url("./assets/link-marks/video.svg");
}
[data-link-resource="image"] {
    --link-resource-mask: url("./assets/link-marks/image.svg");
}
```

Run Biome formatting after insertion. Add per-resource `--link-resource-size` or `--link-resource-align` overrides only when the browser matrix demonstrates a mismatch; record the observed icon and exact adjustment in the task review.

- [ ] **Step 3: Add the complete Storybook visual matrix**

Append this story to `MarkdownRenderer.stories.tsx`:

```tsx
export const LinkResourceMarks: Story = {
  args: {
    content: `## Resource marks

[Wikipedia](https://en.wikipedia.org/wiki/Hypertext) · [arXiv](https://arxiv.org/abs/2401.00001) · [bioRxiv](https://biorxiv.org/content/10.1101/example) · [DOI](https://doi.org/10.1000/example) · [PubMed](https://pubmed.ncbi.nlm.nih.gov/12345678/) · [Semantic Scholar](https://semanticscholar.org/paper/example)

[GitHub](https://github.com/example/project) · [GitLab](https://gitlab.com/example/project) · [Internet Archive](https://archive.org/details/example) · [YouTube](https://youtube.com/watch?v=example) · [Vimeo](https://vimeo.com/123)

[PDF](https://example.com/paper.pdf) · [audio](https://example.com/audio.flac) · [video](https://example.com/movie.webm) · [image](https://example.com/image.avif) · [ordinary external](https://example.com/page) · [internal](/pages/notes/example.md)

Wrapped sentence: Read [a deliberately long Wikipedia link label that approaches the edge of its container](https://en.wikipedia.org/wiki/Hypertext), then continue after punctuation. Adjacent: [one](https://github.com/a)[two](https://gitlab.com/b).`,
  },
  parameters: {
    layout: "padded",
  },
};
```

- [ ] **Step 4: Run focused tests, typecheck, lint, and Storybook build**

```bash
bun --cwd ui run test -- src/lib/linkResource.test.ts src/components/MarkdownRenderer.test.tsx src/components/codex/PreviewMarkdown.test.tsx src/editor/elements/LinkElement.test.tsx src/components/docs/__tests__/DocsArticle.test.tsx
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run build-storybook
```

Expected: every command exits 0; Vite resolves every SVG mask URL.

- [ ] **Step 5: Commit visual assets and styles**

```bash
git add ui/src/assets/link-marks ui/src/main.css ui/src/components/MarkdownRenderer.stories.tsx
git commit -m "feat(ui): style external resource marks"
```

---

### Task 6: Browser smoke test and verification gates

**Files:**
- Modify only if verification exposes a real defect in files already named by Tasks 1–5.

**Interfaces:**
- Consumes: the completed classifier, renderer metadata, assets, CSS, and Storybook story.
- Produces: observed end-to-end proof and any narrowly scoped corrections.

- [ ] **Step 1: Start Storybook as a managed long-running process**

Run through the harness process manager, not a background shell:

```text
application: bun
args: ["--cwd", "ui", "run", "storybook", "--", "--host", "127.0.0.1"]
readiness: log matching "Storybook" and TCP port 6006
```

Open the `Components/MarkdownRenderer` → `Link Resource Marks` story in the browser.

- [ ] **Step 2: Verify the complete visual matrix**

At desktop width and a narrow width near 360 CSS pixels, observe and record:

- all 15 marks render and remain recognizable;
- ordinary external and internal links have no mark;
- marks inherit link color in paper and dark themes;
- hover and keyboard focus raise opacity without moving text;
- punctuation stays outside the visual mark;
- long links wrap without an orphaned or overlapping mark;
- adjacent marked links remain distinguishable;
- no horizontal overflow is introduced.

If one mark is optically inconsistent, change only its CSS custom-property override or its SVG view box, rerun the focused Storybook check, and include that exact change in the final verification report.

- [ ] **Step 3: Smoke-test the live Slate editor**

Start two managed processes: backend `cargo` with arguments `["run", "--", "serve"]`, ready on TCP port `3000`; frontend `bun` with arguments `["--cwd", "ui", "run", "dev", "--", "--host", "127.0.0.1"]`, ready on TCP port `5173`. Open `http://127.0.0.1:5173`, then open or create a disposable note containing a Wikipedia Markdown link and verify:

- the stylized `W` appears after the link;
- left/right arrow movement crosses the link boundary normally;
- clicking places the caret as before;
- Shift+Arrow selection includes only the link label;
- Backspace/Delete behavior is unchanged;
- Cmd/Ctrl-click still opens the target;
- the popover's Open and Copy actions still work;
- copied text and saved Markdown contain no mark character or resource metadata.

Do not retain the disposable note in repository fixtures or user-authored content.

- [ ] **Step 4: Run focused and full UI verification**

```bash
bun --cwd ui run test -- src/lib/linkResource.test.ts src/components/MarkdownRenderer.test.tsx src/components/codex/PreviewMarkdown.test.tsx src/editor/elements/LinkElement.test.tsx src/components/docs/__tests__/DocsArticle.test.tsx
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
bun --cwd ui run build
```

Expected: all commands exit 0; Vitest reports zero failures; Vite emits the production bundle.

- [ ] **Step 5: Run repository verification gates**

```bash
cargo fmt --all -- --check
cargo clippy --all-targets
cargo test
```

Expected: all commands exit 0. Do not suppress or waive failures; distinguish a pre-existing unrelated failure with exact command output and resolve every failure caused by this feature.

- [ ] **Step 6: Commit only verification-driven corrections**

If Steps 2–5 required code or asset corrections:

```bash
git add -p ui/src
git commit -m "fix(ui): refine external resource marks"
```

If no files changed, do not create an empty commit.

- [ ] **Step 7: Request code review before integration**

Invoke `superpowers:requesting-code-review`. Review against:

- `docs/superpowers/specs/2026-08-08-link-resource-marks-design.md`
- this implementation plan;
- hostname spoofing and precedence;
- accessible names and generated content;
- Slate caret/selection behavior;
- SVG provenance and build resolution;
- all observed verification evidence.
