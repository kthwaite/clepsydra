import { lazy } from "react";
import basesSource from "#/docs/content/bases.mdx?raw";
import cliSource from "#/docs/content/cli.mdx?raw";
import configurationSource from "#/docs/content/configuration.mdx?raw";
import gettingStartedSource from "#/docs/content/getting-started.mdx?raw";
import lspSource from "#/docs/content/lsp.mdx?raw";
import mcpSource from "#/docs/content/mcp.mdx?raw";

export { DEFAULT_DOC_SLUG } from "#/docs/constants";

import type { DocGroup, DocMeta, DocPage } from "#/docs/types";

const GettingStartedGuide = lazy(() =>
  import("#/docs/content/getting-started.mdx"),
);
const ConfigurationGuide = lazy(() =>
  import("#/docs/content/configuration.mdx"),
);
const CliGuide = lazy(() => import("#/docs/content/cli.mdx"));
const BasesGuide = lazy(() => import("#/docs/content/bases.mdx"));
const LspGuide = lazy(() => import("#/docs/content/lsp.mdx"));
const McpGuide = lazy(() => import("#/docs/content/mcp.mdx"));

const gettingStartedMeta = {
  slug: "getting-started",
  title: "Getting Started",
  description: "Run Clepsydra with an initialized vault.",
} satisfies DocMeta;
const configurationMeta = {
  slug: "configuration",
  title: "Configuration",
  description: "Configure Clepsydra’s server, vault, TLS, and runtime behavior.",
} satisfies DocMeta;
const cliMeta = {
  slug: "cli",
  title: "CLI",
  description: "Use Clepsydra’s command-line interface.",
} satisfies DocMeta;
const basesMeta = {
  slug: "bases",
  title: "Bases",
  description: "Define typed fields and filtered table views.",
} satisfies DocMeta;
const lspMeta = {
  slug: "lsp",
  title: "LSP",
  description: "Use Clepsydra’s language server in Markdown editors.",
} satisfies DocMeta;
const mcpMeta = {
  slug: "mcp",
  title: "MCP",
  description: "Connect agents to Clepsydra through the Model Context Protocol.",
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
const configuration = page(
  "start",
  configurationMeta,
  ConfigurationGuide,
  configurationSource,
);
const cli = page("reference", cliMeta, CliGuide, cliSource);
const bases = page("features", basesMeta, BasesGuide, basesSource);
const lsp = page("integrations", lspMeta, LspGuide, lspSource);
const mcp = page("integrations", mcpMeta, McpGuide, mcpSource);

export const DOC_GROUPS = [
  { id: "start", label: "Start Here", pages: [gettingStarted, configuration] },
  { id: "reference", label: "Reference", pages: [cli] },
  { id: "features", label: "Features", pages: [bases] },
  { id: "integrations", label: "Integrations", pages: [lsp, mcp] },
] as const satisfies readonly DocGroup[];

export const DOC_PAGES: readonly DocPage[] = DOC_GROUPS.flatMap(
  (group) => group.pages,
);

export function getDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((entry) => entry.slug === slug);
}

export function getDocNeighbors(
  slug: string,
): { previous?: DocPage; next?: DocPage } {
  const index = DOC_PAGES.findIndex((entry) => entry.slug === slug);
  return index < 0
    ? {}
    : { previous: DOC_PAGES[index - 1], next: DOC_PAGES[index + 1] };
}
