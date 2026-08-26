import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { STATIC_COMMANDS } from "#/components/codex/commandRegistry";
import { docsMdxComponents } from "#/components/docs/DocsMdxComponents";
import BooksAndReading, {
  meta as booksAndReadingMeta,
} from "#/docs/content/books-and-reading.mdx";
import BrowserExtension, {
  meta as browserExtensionMeta,
} from "#/docs/content/browser-extension.mdx";
import Configuration from "#/docs/content/configuration.mdx";
import Guide, { meta } from "#/docs/content/getting-started.mdx";
import source from "#/docs/content/getting-started.mdx?raw";
import Recipes, { meta as recipesMeta } from "#/docs/content/recipes.mdx";
import Troubleshooting, {
  meta as troubleshootingMeta,
} from "#/docs/content/troubleshooting.mdx";
import { FEATURE_INVENTORY } from "#/docs/featureInventory";
import { DOC_PAGES } from "#/docs/registry";
import { routeTree } from "#/routeTree.gen";

const STRUCTURED_GUIDE_SLUGS = [
  ...new Set(
    FEATURE_INVENTORY.flatMap((entry) =>
      entry.disposition.kind === "guide" ? [entry.disposition.slug] : [],
    ),
  ),
];

const WORKFLOW_GUIDE_HEADINGS = [
  "Prerequisites",
  "Workflow",
  "Failures and conflicts",
  "Privacy",
  "Related",
] as const;

const INTEGRATION_GUIDE_SLUGS = [
  ...new Set(
    FEATURE_INVENTORY.filter(
      (entry) => entry.surface === "integration",
    ).flatMap((entry) =>
      entry.disposition.kind === "guide" ? [entry.disposition.slug] : [],
    ),
  ),
];

it("compiles MDX, preserves typed metadata, and exposes raw source", () => {
  render(<Guide />);
  expect(
    screen.getByRole("heading", { name: "Prerequisites" }),
  ).toHaveAttribute("id", "prerequisites");
  expect(meta.slug).toBe("getting-started");
  expect(source).toContain(
    "This guide gets Clepsydra running locally with an initialized vault.",
  );
});

it("documents every accepted arXiv identifier form and rejects URL input", () => {
  expect(source).toContain("modern `NNNN.NNNN` or `NNNN.NNNNN`");
  expect(source).toContain("legacy `archive/NNNNNNN` form");
  expect(source).toContain("optional positive `vN` version suffix");
  expect(source).toContain("identifiers, not full arXiv URLs");
});

it.each(DOC_PAGES)(
  "renders the registered $slug guide component",
  async ({ Component }) => {
    const { container } = render(<Component />);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  },
);

it("resolves every rendered internal documentation link to a registered guide and heading", async () => {
  const renderedLinks: Array<{ sourceSlug: string; href: string }> = [];

  for (const sourcePage of DOC_PAGES) {
    const rendered = render(<sourcePage.Component />);
    await waitFor(() => expect(rendered.container).not.toBeEmptyDOMElement());
    for (const anchor of rendered.container.querySelectorAll<HTMLAnchorElement>(
      'a[href="/docs"], a[href^="/docs/"], a[href^="/docs#"]',
    )) {
      renderedLinks.push({
        sourceSlug: sourcePage.slug,
        href: anchor.getAttribute("href") ?? "",
      });
    }
    rendered.unmount();
  }

  const fragmentLinks = renderedLinks.filter(({ href }) => href.includes("#"));
  expect(renderedLinks.length).toBeGreaterThan(0);
  expect(fragmentLinks.length).toBeGreaterThan(0);

  for (const { sourceSlug, href } of renderedLinks) {
    const target = new URL(href, "https://clepsydra.invalid");
    const targetSlug =
      target.pathname === "/docs"
        ? "getting-started"
        : target.pathname.slice("/docs/".length);
    const targetPage = DOC_PAGES.find((page) => page.slug === targetSlug);
    expect(
      targetPage,
      `${sourceSlug} renders unresolved documentation link ${href}`,
    ).toBeDefined();

    if (targetPage && target.hash) {
      const renderedTarget = render(<targetPage.Component />);
      await waitFor(() =>
        expect(renderedTarget.container).not.toBeEmptyDOMElement(),
      );
      expect(
        renderedTarget.container.querySelector(
          `#${CSS.escape(target.hash.slice(1))}`,
        ),
        `${sourceSlug} renders unresolved documentation fragment ${href}`,
      ).not.toBeNull();
      renderedTarget.unmount();
    }
  }
});

it.each(STRUCTURED_GUIDE_SLUGS)(
  "$slug follows the shared guide structure",
  (slug) => {
    const source = DOC_PAGES.find((page) => page.slug === slug)?.source;

    expect(source, `${slug} must be registered`).toBeDefined();
    for (const heading of WORKFLOW_GUIDE_HEADINGS) {
      expect(source).toMatch(new RegExp(`^## ${heading}$`, "m"));
    }
  },
);

it.each(INTEGRATION_GUIDE_SLUGS)(
  "$slug follows the integration guide structure and links operational help",
  (slug) => {
    const source = DOC_PAGES.find((page) => page.slug === slug)?.source;

    expect(source, `${slug} must be registered`).toBeDefined();
    for (const heading of WORKFLOW_GUIDE_HEADINGS) {
      expect(source).toMatch(new RegExp(`^## ${heading}$`, "m"));
    }
    expect(source).toContain("(/docs/configuration)");
    expect(source).toContain("(/docs/troubleshooting)");
  },
);

it("documents the plaintext Base definition, property, projection, and protected-body boundaries", () => {
  const source = DOC_PAGES.find((page) => page.slug === "bases")?.source;

  expect(source).toContain("`.base.toml` definitions are plaintext");
  expect(source).toMatch(
    /frontmatter properties and\s+relation values are plaintext/i,
  );
  expect(source).toMatch(/index projections of that metadata are\s+plaintext/i);
  expect(source).toMatch(
    /protected folio bodies do not contribute body-derived[\s\S]*frontmatter\s+remains available/i,
  );
});

it("documents mutation preview snapshots and recursive folder deletion", () => {
  const source = DOC_PAGES.find(
    (page) => page.slug === "pages-and-authoring",
  )?.source;

  expect(source).toContain("preview is a snapshot");
  expect(source).toMatch(/replans\s+against the current vault/);
  expect(source).toMatch(
    /Recursive folder\s+deletion does not check or rewrite inbound links/,
  );
});

it("documents the protected-page API trust and size boundaries", () => {
  const source = DOC_PAGES.find(
    (page) => page.slug === "encryption-and-protected-pages",
  )?.source;

  expect(source).toContain("shipped frontend safeguards");
  expect(source).toMatch(
    /cannot attest that the browser was unlocked, that the user\s+acknowledged/,
  );
  expect(source).toContain("complete canonical age v1 armored body");
  expect(source).toContain("2 MiB");
  expect(source).toMatch(/encryption\s+overhead/);
});

it("links Getting Started to both dedicated guides", () => {
  render(<Guide />);

  expect(
    screen.getByRole("link", { name: "Browser Extension guide" }),
  ).toHaveAttribute("href", "/docs/browser-extension");
  expect(
    screen.getByRole("link", { name: "Troubleshooting guide" }),
  ).toHaveAttribute("href", "/docs/troubleshooting");
});

it("renders the dedicated troubleshooting guide", () => {
  render(<Troubleshooting />);
  expect(troubleshootingMeta.slug).toBe("troubleshooting");
  expect(
    screen.getByRole("heading", {
      name: "UI doesn’t load in single-binary mode",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("clep config path --trace")).toBeInTheDocument();
});

it("renders self-contained browser extension setup", () => {
  render(<BrowserExtension />);
  expect(browserExtensionMeta.slug).toBe("browser-extension");
  expect(
    screen.getByRole("heading", {
      name: "Install in Chrome, Chromium, Brave, or Edge",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("extension/dist", { exact: true }),
  ).toBeInTheDocument();
  expect(screen.getByText("Connected", { exact: true })).toBeInTheDocument();
  expect(
    screen.getByRole("heading", {
      name: "Firefox: rebuild before reloading",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("HTTP 409", { exact: true })).toBeInTheDocument();
  expect(
    screen.getByText("notification only", { exact: true }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("on_content_changed", { exact: true }),
  ).toBeInTheDocument();
  // Pin what the worker's fallback Markdown actually emits (no snapshot
  // link — buildFallbackMarkdown only records the URL and capture time) so
  // this doc can't drift from extension/src/background/service-worker.ts
  // again without failing here.
  expect(
    screen.getByText(
      /noting that the captured snapshot is still archived and viewable/,
    ),
  ).toBeInTheDocument();
});

it("renders the Books and Reading workflow", () => {
  render(<BooksAndReading />);
  expect(booksAndReadingMeta.slug).toBe("books-and-reading");
  expect(
    screen.getByRole("heading", { name: "Scan a book barcode" }),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Add book by ISBN", { exact: true })).toHaveLength(
    2,
  );
  expect(
    screen.getByText("academic.books_folder", { exact: true }),
  ).toBeInTheDocument();
});

it("renders the Recipes workflow", () => {
  render(<Recipes />);
  expect(recipesMeta.slug).toBe("recipes");
  expect(
    screen.getByRole("heading", { name: "Recipe format" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Structured editing" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", {
      name: "When Clepsydra falls back to Markdown",
    }),
  ).toBeInTheDocument();
});

it("renders GFM tables as semantic HTML", () => {
  render(
    <Configuration
      components={{
        table: docsMdxComponents.table,
        th: docsMdxComponents.th,
        td: docsMdxComponents.td,
      }}
    />,
  );

  const table = screen.getAllByRole("table")[1];
  expect(table.closest('[role="region"]')).toHaveAccessibleName(
    "Scrollable table",
  );
  expect(
    within(table).getByRole("columnheader", { name: "Key" }),
  ).toBeInTheDocument();
  expect(
    within(table).getByRole("cell", { name: "attachment_folder" }),
  ).toBeInTheDocument();
});

it("renders the protected-note attachment security boundary", () => {
  render(<Configuration />);

  expect(
    screen.getByRole("heading", {
      name: "Protected notes and plaintext attachments",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "attachment management" }),
  ).toHaveAttribute("href", "#attachment-management");
  expect(
    screen.getByText(/client-only, best-effort check/i),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/ignores raw HTML, code, malformed or unresolved links/i),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /absence of a warning is not proof that no stale reference exists/i,
    ),
  ).toBeInTheDocument();
});

it("renders repository-only guide references as non-clickable source paths", () => {
  render(<Configuration />);

  const references = screen.getAllByText("docs/encrypted-notes.md");
  expect(references).toHaveLength(2);
  for (const reference of references) {
    expect(reference).toHaveProperty("tagName", "CODE");
  }
  expect(
    screen.queryByRole("link", { name: "encrypted-notes.md" }),
  ).not.toBeInTheDocument();
});

function registeredGuideSource(slug: string): string {
  return DOC_PAGES.find((page) => page.slug === slug)?.source ?? "";
}

it("documents SHEAF close and ordering behavior", () => {
  const source = registeredGuideSource("codex-and-conversation-capture");

  expect(source).toContain(
    "**CLOSE QUIRE** closes every member and dissolves the empty quire",
  );
  expect(source).toContain(
    "The SHEAF follows workspace order, while each quire keeps its member order",
  );
  expect(source).toMatch(
    /Recent Folios\s+are ordered by activation, newest first/,
  );
});

it("documents executable Helix LSP setup without dropping current servers", () => {
  const source = registeredGuideSource("lsp");

  expect(source).toContain("[language-server.clepsydra]");
  expect(source).toContain('command = "clep"');
  expect(source).toContain('args = ["lsp"]');
  expect(source).toContain('name = "markdown"');
  expect(source).toContain(
    'language-servers = ["marksman", "markdown-oxide", "rumdl", "clepsydra"]',
  );
  expect(source).toContain("do not replace the list with only");
});

it("documents conversation results and exact MCP stale-guard ownership", () => {
  const source = registeredGuideSource("mcp");

  for (const field of [
    "`path`",
    "`page_id`",
    "`operation`",
    "`appended_turns`",
    "`skipped_turns`",
    "`warnings`",
  ]) {
    expect(source).toContain(field);
  }
  expect(source).toContain("`created`, `appended`, or `unchanged`");
  expect(source).toMatch(
    /Only `vault_update_page`, `vault_edit_page`, and\s+`vault_append_page` read and send `expected_revision`/,
  );
  expect(source).toContain("atomic\n  no-overwrite creation");
  expect(source).toContain("do not send a revision");
});

it("documents the SingleFile capture and server-side deconstruction pipeline", () => {
  const source = registeredGuideSource("browser-extension");

  // A second content script answers SingleFile's frame-tree handshake, or
  // every iframe on the page burns a five-second timeout and archives nothing.
  expect(source).toContain(
    "A second content script is injected into every frame",
  );
  expect(source).toContain("frame-tree handshake");
  // Cross-origin fetches relay through the worker because a content script's
  // `fetch` is bound by the page's CORS policy, not the extension's host
  // permissions.
  expect(source).toMatch(/bound by the \*page.s\* CORS policy/);
  expect(source).toContain("relays through the background worker instead");
  // The extension no longer owns the resource map: it posts one inlined
  // snapshot and the server alone deconstructs, hashes, and rewrites it.
  expect(source).toContain(
    "The extension does not hash, split, or deduplicate resources itself.",
  );
  expect(source).toContain("server alone deconstructs `snapshot_html`");
  expect(source).toContain("`cas:` references from a single resource map");
  // source_hash (captured) and content_hash (stored) are distinct hashes over
  // the Markdown before and after image-URL rewriting, not the same value
  // under two names.
  expect(source).toContain("`archive.source_hash`");
  expect(source).toContain("`archive.content_hash`");
  // Per-resource limit is declined at capture time; the total budget is
  // enforced by the server alone, not the client.
  expect(source).toContain(
    "that exceeds `max_blob_size_mb`, is left out of the snapshot",
  );
  expect(source).toContain("exceeds `max_request_size_mb`");
  for (const field of [
    "`domain`",
    "`captured_at`",
    "`content_hash`",
    "`snapshot_html`",
    "`markdown_body`",
    "`byline`",
    "`site_name`",
    "`published_time`",
    "`lang`",
    "`excerpt`",
  ]) {
    expect(source).toContain(field);
  }
});

it("documents consolidated local-date Agenda semantics and Todo controls", () => {
  const source = registeredGuideSource("tasks-agenda-journals-and-board");
  const editorSource = registeredGuideSource("editor-workflows");

  expect(source).toContain("server does not validate them as dates");
  expect(source).toContain("compares indexed values lexicographically");
  expect(source).toMatch(/rewrite a different nearby\s+checkbox/);
  expect(source).toContain("Todos and dated Tasks");
  expect(source).toContain("browser’s local date");
  expect(source).toContain("**Undated**");
  expect(source).toMatch(
    /\*\*Today\*\* contains[\s\S]*open Todos scheduled today[\s\S]*open Todos\s+in today’s journal/,
  );
  expect(source).toMatch(
    /overdue `due` date wins[\s\S]*scheduled today[\s\S]*today’s journal/,
  );
  expect(source).toMatch(
    /\*\*Undated\*\* contains other open Todos without a `due` property\.[\s\S]*scheduled today\s+or contained in today’s journal belongs in \*\*Today\*\*/,
  );
  expect(source).not.toContain("both **Overdue** and **Due Today**");
  expect(source).not.toContain("calendar boundaries in UTC");
  expect(source).not.toContain("**Inbox** shows open Todos");
  expect(source).toContain("Task `status`: Inbox (`INTAKE`)");
  expect(source).toContain("**Todo properties**");
  expect(editorSource).toContain("**Todo properties**");
  expect(source).not.toContain("**Task properties**");
  expect(editorSource).not.toContain("**Task properties**");
  expect(editorSource).not.toMatch(/\btask items?\b/i);
  expect(editorSource).not.toContain("agenda's task list");
  expect(editorSource).toContain("Todo list item");
  expect(editorSource).toContain("### Edit Todos and their properties");
  expect(editorSource).toContain(
    "[Edit Todos and their properties](#edit-todos-and-their-properties)",
  );
  expect(editorSource).not.toContain("Edit tasks and their properties");
  expect(editorSource).toContain("**Task list** slash command");
});

it("documents exact academic deduplication and Zotero status matrices", () => {
  const source = registeredGuideSource("academic-library-and-reading");

  for (const status of [
    "`would_create`",
    "`would_skip`",
    "`would_update`",
    "`conflict`",
    "`skipped`",
    "`created`",
    "`updated`",
    "`error`",
  ]) {
    expect(source).toContain(status);
  }
  expect(source).toContain(
    "DOI and ISBN deduplication compares exact indexed strings",
  );
  expect(source).toMatch(/BibTeX and\s+Zotero preserve source spelling/);
});

it("documents extension permissions and complete capture scope", () => {
  const source = registeredGuideSource("capture-feeds-and-archives");

  expect(source).toMatch(
    /`activeTab`, `storage`, `notifications`, and\s+`scripting`/,
  );
  expect(source).toContain("`http://*/*` and `https://*/*`");
  expect(source).toContain("current page DOM");
  // SingleFile fetches every resource type it can reach, not just images; a
  // fetch that fails under the page's CORS policy relays through the worker.
  expect(source).toMatch(/relay any cross-origin\s+resource fetch/);
  // The server, not the extension, owns the resource map: it deconstructs the
  // one posted snapshot and computes its own hashes for every resource in it.
  expect(source).toMatch(
    /computes its own hashes for the snapshot and\s+every resource it deconstructs from it/,
  );
  expect(source).toContain(
    "does not hash, split, or upload resources itself.",
  );
  expect(source).toMatch(/configured\s+Clepsydra server/);
});

it("documents feed scheduling, retention budgets, and Saved growth", () => {
  const source = registeredGuideSource("capture-feeds-and-archives");

  expect(source).toContain("60-second due sweep");
  expect(source).toContain("30-minute base interval");
  expect(source).toContain("capped at 24 hours");
  expect(source).toContain("5,000 entries or 128 MiB per feed");
  expect(source).toMatch(/50,000\s+entries or 1 GiB globally/);
  expect(source).toContain("Saved entries are exempt");
});

it("documents warning-only archive deletion hooks and CAS recovery limits", () => {
  const source = registeredGuideSource("capture-feeds-and-archives");

  expect(source).toMatch(/warning after the Folio\s+deletion has succeeded/);
  expect(source).toMatch(/leaked reference\s+counts/);
  expect(source).toContain("archive-import or reference-replay");
  expect(source).toContain("complete CAS directory, including `cas.db`");
});

function runtimeRoutePaths(): string[] {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return Object.values(router.routesById)
    .filter((route) => route.id !== "__root__")
    .map((route) => route.fullPath);
}

it("cross-links the knowledge guides and repair workspace", () => {
  const linksGuide = registeredGuideSource("links-search-graph-and-repair");
  const basesGuide = registeredGuideSource("bases");

  expect(linksGuide).toContain("](/docs/block-references-and-transclusion)");
  expect(linksGuide).toContain("](/repairs)");
  expect(linksGuide).toContain("](/docs/bases)");
  expect(linksGuide).toContain("](/docs/lsp)");
  expect(basesGuide).toContain(
    "](/docs/links-search-graph-and-repair#relation-repair)",
  );
});

it("documents the shipped link, search, graph, and repair contracts", () => {
  const source = registeredGuideSource("links-search-graph-and-repair");

  for (const issueKind of [
    "unresolved_page_link",
    "ambiguous_page_link",
    "broken_block_ref",
    "invalid_relation_target",
    "orphan_page",
    "isolated_page",
  ]) {
    expect(source).toContain(`\`${issueKind}\``);
  }
  expect(source).toContain("titles, filenames, paths, and aliases");
  expect(source).toContain("title and body");
  expect(source).toContain("resolved links");
  expect(source).toContain("one issue at a time");
  expect(source).toContain("no bulk apply");
  expect(source).toContain("remains in the list");
  expect(source).toContain("409");
  expect(source).toContain("Protected outbound body topology is unavailable");
  expect(source).toContain(
    "an inbound-free protected page is reported as an orphan",
  );
});

it("documents single-block non-recursive transclusion and its privacy boundary", () => {
  const source = registeredGuideSource("block-references-and-transclusion");

  expect(source).toContain("one read-only block");
  expect(source).toContain("Nested reference tokens remain inert");
  expect(source).toContain("Referenced block unavailable");
  expect(source).toContain(
    "protected and missing targets are indistinguishable",
  );
  expect(source).toContain("assigns the ID to the source block");
  expect(source).toContain(
    "current detail endpoint returns the first matching row",
  );
  expect(source).toContain(
    "displayed transclusion can therefore disagree with graph and Reference Repairs",
  );
});

it("documents Bases as non-owning saved views with safe property mutation", () => {
  const source = registeredGuideSource("bases");

  expect(source).toContain("saved, non-owning view");
  expect(source).toContain("does not move, copy, or own");
  expect(source).toContain("preserving untouched keys and comments");
  expect(source).toContain("stale edit is rejected");
  expect(source).toContain("many = false");
  expect(source).toContain("warning");
  expect(source).toContain("A Base embed is a live, non-owning view");
  expect(source).toContain(
    "id, path, title, kind, project, tags, aliases, created_at, updated_at, encryption, journal_date, word_count",
  );
  expect(source).toContain(
    "Bare and `sys.`-prefixed scalar names are materialized under the exact requested column key",
  );
  expect(source).toContain(
    "It does not diagnose an ambiguous relation target as ambiguous",
  );
  expect(source).toContain(
    "The LSP warns when a relation target is missing; Reference Repairs projects both missing and ambiguous targets",
  );
  expect(source).not.toContain(
    "A missing or ambiguous target produces an LSP warning",
  );
});

it("keeps every documented knowledge route and command grounded in runtime registries", () => {
  const routes = new Set(runtimeRoutePaths());
  const commands = new Map(
    STATIC_COMMANDS.map((command) => [command.id, command.title]),
  );
  const routeClaims = [
    {
      slug: "links-search-graph-and-repair",
      sourceText: "`/graph`",
      path: "/graph",
    },
    {
      slug: "links-search-graph-and-repair",
      sourceText: "`/repairs`",
      path: "/repairs",
    },
    { slug: "bases", sourceText: "`/bases`", path: "/bases/" },
    {
      slug: "bases",
      sourceText: "`/bases/<slug>`",
      path: "/bases/$slug",
    },
    {
      slug: "bases",
      sourceText: "`/bases/<slug>/edit`",
      path: "/bases/$slug/edit",
    },
  ] as const;
  const commandClaims = [
    {
      slug: "links-search-graph-and-repair",
      id: "nav.constellation",
      title: "Open Constellation (graph)",
    },
    {
      slug: "links-search-graph-and-repair",
      id: "nav.repairs",
      title: "Open Reference Repairs",
    },
    { slug: "bases", id: "nav.bases", title: "Open Bases" },
    { slug: "bases", id: "bases.create", title: "Create Base" },
  ] as const;

  for (const claim of routeClaims) {
    expect(registeredGuideSource(claim.slug)).toContain(claim.sourceText);
    expect(routes).toContain(claim.path);
  }
  for (const claim of commandClaims) {
    expect(registeredGuideSource(claim.slug)).toContain(claim.title);
    expect(commands.get(claim.id)).toBe(claim.title);
  }
});
