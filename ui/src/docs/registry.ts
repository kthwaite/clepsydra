import { lazy } from "react";
import academicLibraryAndReadingSource from "#/docs/content/academic-library-and-reading.mdx?raw";
import attachmentsAndMediaSource from "#/docs/content/attachments-and-media.mdx?raw";
import basesSource from "#/docs/content/bases.mdx?raw";
import blockReferencesAndTransclusionSource from "#/docs/content/block-references-and-transclusion.mdx?raw";
import booksAndReadingSource from "#/docs/content/books-and-reading.mdx?raw";
import browserExtensionSource from "#/docs/content/browser-extension.mdx?raw";
import captureFeedsAndArchivesSource from "#/docs/content/capture-feeds-and-archives.mdx?raw";
import cliSource from "#/docs/content/cli.mdx?raw";
import configurationSource from "#/docs/content/configuration.mdx?raw";
import editorWorkflowsSource from "#/docs/content/editor-workflows.mdx?raw";
import encryptionAndProtectedPagesSource from "#/docs/content/encryption-and-protected-pages.mdx?raw";
import gettingStartedSource from "#/docs/content/getting-started.mdx?raw";
import linksSearchGraphAndRepairSource from "#/docs/content/links-search-graph-and-repair.mdx?raw";
import lspSource from "#/docs/content/lsp.mdx?raw";
import mcpSource from "#/docs/content/mcp.mdx?raw";
import pagesAndAuthoringSource from "#/docs/content/pages-and-authoring.mdx?raw";
import tasksAgendaJournalsAndBoardSource from "#/docs/content/tasks-agenda-journals-and-board.mdx?raw";
import troubleshootingSource from "#/docs/content/troubleshooting.mdx?raw";

export { DEFAULT_DOC_SLUG } from "#/docs/constants";

import type { DocGroup, DocMeta, DocPage } from "#/docs/types";

const GettingStartedGuide = lazy(
  () => import("#/docs/content/getting-started.mdx"),
);
const PagesAndAuthoringGuide = lazy(
  () => import("#/docs/content/pages-and-authoring.mdx"),
);
const EditorWorkflowsGuide = lazy(
  () => import("#/docs/content/editor-workflows.mdx"),
);
const AttachmentsAndMediaGuide = lazy(
  () => import("#/docs/content/attachments-and-media.mdx"),
);
const EncryptionAndProtectedPagesGuide = lazy(
  () => import("#/docs/content/encryption-and-protected-pages.mdx"),
);
const ConfigurationGuide = lazy(
  () => import("#/docs/content/configuration.mdx"),
);
const TroubleshootingGuide = lazy(
  () => import("#/docs/content/troubleshooting.mdx"),
);
const CliGuide = lazy(() => import("#/docs/content/cli.mdx"));
const LinksSearchGraphAndRepairGuide = lazy(
  () => import("#/docs/content/links-search-graph-and-repair.mdx"),
);
const BlockReferencesAndTransclusionGuide = lazy(
  () => import("#/docs/content/block-references-and-transclusion.mdx"),
);
const BasesGuide = lazy(() => import("#/docs/content/bases.mdx"));
const TasksAgendaJournalsAndBoardGuide = lazy(
  () => import("#/docs/content/tasks-agenda-journals-and-board.mdx"),
);
const AcademicLibraryAndReadingGuide = lazy(
  () => import("#/docs/content/academic-library-and-reading.mdx"),
);
const BooksAndReadingGuide = lazy(
  () => import("#/docs/content/books-and-reading.mdx"),
);
const LspGuide = lazy(() => import("#/docs/content/lsp.mdx"));
const McpGuide = lazy(() => import("#/docs/content/mcp.mdx"));
const BrowserExtensionGuide = lazy(
  () => import("#/docs/content/browser-extension.mdx"),
);
const CaptureFeedsAndArchivesGuide = lazy(
  () => import("#/docs/content/capture-feeds-and-archives.mdx"),
);

const gettingStartedMeta = {
  slug: "getting-started",
  title: "Getting Started",
  description: "Run Clepsydra with an initialized vault.",
  keywords: ["install", "setup", "vault", "server"],
} satisfies DocMeta;
const pagesAndAuthoringMeta = {
  slug: "pages-and-authoring",
  title: "Pages and Authoring",
  description: "Create, organize, move, and delete folios.",
  keywords: ["pages", "folios", "folders", "frontmatter", "moves"],
} satisfies DocMeta;
const editorWorkflowsMeta = {
  slug: "editor-workflows",
  title: "Editor Workflows",
  description:
    "Edit folios with autosave, slash commands, embeds, and block references.",
  keywords: ["editor", "autosave", "Markdown", "slash commands", "blocks"],
} satisfies DocMeta;
const attachmentsAndMediaMeta = {
  slug: "attachments-and-media",
  title: "Attachments and Media",
  description: "Upload, insert, audit, and delete vault attachments.",
  keywords: ["attachments", "media", "uploads", "images", "files"],
} satisfies DocMeta;
const encryptionAndProtectedPagesMeta = {
  slug: "encryption-and-protected-pages",
  title: "Encryption and Protected Pages",
  description: "Set up encryption and protect, unlock, edit, and recover folios.",
  keywords: ["encryption", "protected pages", "age", "privacy", "recovery"],
} satisfies DocMeta;
const configurationMeta = {
  slug: "configuration",
  title: "Configuration",
  description:
    "Configure Clepsydra’s server, vault, TLS, and runtime behavior.",
  keywords: ["config", "environment", "TLS", "server", "vault"],
} satisfies DocMeta;
const troubleshootingMeta = {
  slug: "troubleshooting",
  title: "Troubleshooting",
  description: "Resolve common Clepsydra setup, server, UI, and LSP problems.",
  keywords: ["diagnostics", "setup", "server", "UI", "LSP"],
} satisfies DocMeta;
const cliMeta = {
  slug: "cli",
  title: "CLI",
  description: "Use Clepsydra’s command-line interface.",
  keywords: ["command line", "commands", "terminal"],
} satisfies DocMeta;
const linksSearchGraphAndRepairMeta = {
  slug: "links-search-graph-and-repair",
  title: "Links, Search, Graph, and Repair",
  description:
    "Resolve links, search folios, navigate the graph, and repair references.",
  keywords: [
    "wikilinks",
    "backlinks",
    "outlinks",
    "search",
    "graph",
    "repairs",
  ],
} satisfies DocMeta;
const blockReferencesAndTransclusionMeta = {
  slug: "block-references-and-transclusion",
  title: "Block References and Transclusion",
  description:
    "Assign stable block IDs and transclude one non-recursive source block.",
  keywords: ["block references", "block IDs", "transclusion", "embeds"],
} satisfies DocMeta;
const basesMeta = {
  slug: "bases",
  title: "Bases",
  description: "Build saved, non-owning views over typed folio properties.",
  keywords: [
    "database",
    "properties",
    "relations",
    "filters",
    "tables",
    "views",
  ],
} satisfies DocMeta;
const tasksAgendaJournalsAndBoardMeta = {
  slug: "tasks-agenda-journals-and-board",
  title: "Tasks, Agenda, Journals, and Board",
  description:
    "Plan work with Markdown tasks, agenda views, daily journals, and atomic board cycles.",
  keywords: ["tasks", "agenda", "journals", "board", "cycles", "carryover"],
} satisfies DocMeta;
const academicLibraryAndReadingMeta = {
  slug: "academic-library-and-reading",
  title: "Academic Library and Reading",
  description:
    "Import, deduplicate, organize, read, and annotate academic work pages.",
  keywords: [
    "academic",
    "Zotero",
    "BibTeX",
    "DOI",
    "arXiv",
    "citations",
    "annotations",
  ],
} satisfies DocMeta;
const booksAndReadingMeta = {
  slug: "books-and-reading",
  title: "Books and Reading",
  description:
    "Add books from an ISBN or camera barcode and understand imported metadata.",
  keywords: ["books", "reading", "ISBN", "barcode", "metadata"],
} satisfies DocMeta;
const lspMeta = {
  slug: "lsp",
  title: "LSP",
  description: "Use Clepsydra’s language server in Markdown editors.",
  keywords: ["language server", "editor", "Markdown", "autocomplete"],
} satisfies DocMeta;
const mcpMeta = {
  slug: "mcp",
  title: "MCP",
  description:
    "Connect agents to Clepsydra through the Model Context Protocol.",
  keywords: ["Model Context Protocol", "agents", "AI", "tools"],
} satisfies DocMeta;
const browserExtensionMeta = {
  slug: "browser-extension",
  title: "Browser Extension",
  description:
    "Build, install, configure, and use the Clepsydra web archive extension.",
  keywords: ["browser", "extension", "web archive", "capture"],
} satisfies DocMeta;
const captureFeedsAndArchivesMeta = {
  slug: "capture-feeds-and-archives",
  title: "Capture, Feeds, and Archives",
  description:
    "Capture web pages, read private feeds, retain archive blobs, and back up their shipped state.",
  keywords: ["capture", "feeds", "RSS", "Atom", "archive", "CAS", "backup"],
} satisfies DocMeta;

function page(
  groupId: string,
  meta: DocMeta,
  Component: DocPage["Component"],
  source: string,
): DocPage {
  return { ...meta, groupId, Component, source };
}

const gettingStarted = page(
  "start",
  gettingStartedMeta,
  GettingStartedGuide,
  gettingStartedSource,
);
const pagesAndAuthoring = page(
  "pages-authoring",
  pagesAndAuthoringMeta,
  PagesAndAuthoringGuide,
  pagesAndAuthoringSource,
);
const editorWorkflows = page(
  "pages-authoring",
  editorWorkflowsMeta,
  EditorWorkflowsGuide,
  editorWorkflowsSource,
);
const attachmentsAndMedia = page(
  "pages-authoring",
  attachmentsAndMediaMeta,
  AttachmentsAndMediaGuide,
  attachmentsAndMediaSource,
);
const encryptionAndProtectedPages = page(
  "pages-authoring",
  encryptionAndProtectedPagesMeta,
  EncryptionAndProtectedPagesGuide,
  encryptionAndProtectedPagesSource,
);
const configuration = page(
  "operations-reference",
  configurationMeta,
  ConfigurationGuide,
  configurationSource,
);
const troubleshooting = page(
  "operations-reference",
  troubleshootingMeta,
  TroubleshootingGuide,
  troubleshootingSource,
);
const cli = page("operations-reference", cliMeta, CliGuide, cliSource);
const linksSearchGraphAndRepair = page(
  "links-structured-knowledge",
  linksSearchGraphAndRepairMeta,
  LinksSearchGraphAndRepairGuide,
  linksSearchGraphAndRepairSource,
);
const blockReferencesAndTransclusion = page(
  "links-structured-knowledge",
  blockReferencesAndTransclusionMeta,
  BlockReferencesAndTransclusionGuide,
  blockReferencesAndTransclusionSource,
);
const bases = page(
  "links-structured-knowledge",
  basesMeta,
  BasesGuide,
  basesSource,
);
const tasksAgendaJournalsAndBoard = page(
  "work-reading",
  tasksAgendaJournalsAndBoardMeta,
  TasksAgendaJournalsAndBoardGuide,
  tasksAgendaJournalsAndBoardSource,
);
const academicLibraryAndReading = page(
  "work-reading",
  academicLibraryAndReadingMeta,
  AcademicLibraryAndReadingGuide,
  academicLibraryAndReadingSource,
);
const booksAndReading = page(
  "work-reading",
  booksAndReadingMeta,
  BooksAndReadingGuide,
  booksAndReadingSource,
);
const lsp = page("ai-integrations", lspMeta, LspGuide, lspSource);
const mcp = page("ai-integrations", mcpMeta, McpGuide, mcpSource);
const browserExtension = page(
  "capture-feeds-archives",
  browserExtensionMeta,
  BrowserExtensionGuide,
  browserExtensionSource,
);
const captureFeedsAndArchives = page(
  "capture-feeds-archives",
  captureFeedsAndArchivesMeta,
  CaptureFeedsAndArchivesGuide,
  captureFeedsAndArchivesSource,
);

export const DOC_GROUPS = [
  {
    id: "start",
    label: "Start",
    pages: [gettingStarted],
  },
  {
    id: "pages-authoring",
    label: "Pages and authoring",
    pages: [
      pagesAndAuthoring,
      editorWorkflows,
      attachmentsAndMedia,
      encryptionAndProtectedPages,
    ],
  },
  {
    id: "links-structured-knowledge",
    label: "Links and structured knowledge",
    pages: [
      linksSearchGraphAndRepair,
      blockReferencesAndTransclusion,
      bases,
    ],
  },
  {
    id: "work-reading",
    label: "Work and reading",
    pages: [
      tasksAgendaJournalsAndBoard,
      academicLibraryAndReading,
      booksAndReading,
    ],
  },
  {
    id: "capture-feeds-archives",
    label: "Capture, feeds, and archives",
    pages: [captureFeedsAndArchives, browserExtension],
  },
  {
    id: "ai-integrations",
    label: "AI and integrations",
    pages: [lsp, mcp],
  },
  {
    id: "operations-reference",
    label: "Operations and reference",
    pages: [configuration, troubleshooting, cli],
  },
] as const satisfies readonly DocGroup[];

export const DOC_PAGES: readonly DocPage[] = DOC_GROUPS.flatMap(
  (group) => group.pages,
);

export function getDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((entry) => entry.slug === slug);
}

export function getDocNeighbors(slug: string): {
  previous?: DocPage;
  next?: DocPage;
} {
  const index = DOC_PAGES.findIndex((entry) => entry.slug === slug);
  return index < 0
    ? {}
    : { previous: DOC_PAGES[index - 1], next: DOC_PAGES[index + 1] };
}
