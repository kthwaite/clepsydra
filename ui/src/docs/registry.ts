import { lazy } from "react";
import attachmentsAndMediaSource from "#/docs/content/attachments-and-media.mdx?raw";
import basesSource from "#/docs/content/bases.mdx?raw";
import booksAndReadingSource from "#/docs/content/books-and-reading.mdx?raw";
import browserExtensionSource from "#/docs/content/browser-extension.mdx?raw";
import cliSource from "#/docs/content/cli.mdx?raw";
import configurationSource from "#/docs/content/configuration.mdx?raw";
import editorWorkflowsSource from "#/docs/content/editor-workflows.mdx?raw";
import encryptionAndProtectedPagesSource from "#/docs/content/encryption-and-protected-pages.mdx?raw";
import gettingStartedSource from "#/docs/content/getting-started.mdx?raw";
import lspSource from "#/docs/content/lsp.mdx?raw";
import mcpSource from "#/docs/content/mcp.mdx?raw";
import pagesAndAuthoringSource from "#/docs/content/pages-and-authoring.mdx?raw";
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
const BasesGuide = lazy(() => import("#/docs/content/bases.mdx"));
const BooksAndReadingGuide = lazy(
  () => import("#/docs/content/books-and-reading.mdx"),
);
const LspGuide = lazy(() => import("#/docs/content/lsp.mdx"));
const McpGuide = lazy(() => import("#/docs/content/mcp.mdx"));
const BrowserExtensionGuide = lazy(
  () => import("#/docs/content/browser-extension.mdx"),
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
const basesMeta = {
  slug: "bases",
  title: "Bases",
  description: "Define typed fields and filtered table views.",
  keywords: ["database", "properties", "fields", "tables", "views"],
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
const bases = page(
  "links-structured-knowledge",
  basesMeta,
  BasesGuide,
  basesSource,
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
    pages: [bases],
  },
  {
    id: "work-reading",
    label: "Work and reading",
    pages: [booksAndReading],
  },
  {
    id: "capture-feeds-archives",
    label: "Capture, feeds, and archives",
    pages: [browserExtension],
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
