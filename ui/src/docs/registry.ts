import BasesGuide, { meta as basesMeta } from "#/docs/content/bases.mdx";
import basesSource from "#/docs/content/bases.mdx?raw";
import BrowserExtensionGuide, {
  meta as browserExtensionMeta,
} from "#/docs/content/browser-extension.mdx";
import browserExtensionSource from "#/docs/content/browser-extension.mdx?raw";
import CliGuide, { meta as cliMeta } from "#/docs/content/cli.mdx";
import cliSource from "#/docs/content/cli.mdx?raw";
import ConfigurationGuide, {
  meta as configurationMeta,
} from "#/docs/content/configuration.mdx";
import configurationSource from "#/docs/content/configuration.mdx?raw";
import GettingStartedGuide, {
  meta as gettingStartedMeta,
} from "#/docs/content/getting-started.mdx";
import gettingStartedSource from "#/docs/content/getting-started.mdx?raw";
import LspGuide, { meta as lspMeta } from "#/docs/content/lsp.mdx";
import lspSource from "#/docs/content/lsp.mdx?raw";
import McpGuide, { meta as mcpMeta } from "#/docs/content/mcp.mdx";
import mcpSource from "#/docs/content/mcp.mdx?raw";
import TroubleshootingGuide, {
  meta as troubleshootingMeta,
} from "#/docs/content/troubleshooting.mdx";
import troubleshootingSource from "#/docs/content/troubleshooting.mdx?raw";
import type { DocGroup, DocMeta, DocPage } from "#/docs/types";

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
const troubleshooting = page(
  "start",
  troubleshootingMeta,
  TroubleshootingGuide,
  troubleshootingSource,
);
const cli = page("reference", cliMeta, CliGuide, cliSource);
const bases = page("features", basesMeta, BasesGuide, basesSource);
const lsp = page("integrations", lspMeta, LspGuide, lspSource);
const mcp = page("integrations", mcpMeta, McpGuide, mcpSource);
const browserExtension = page(
  "integrations",
  browserExtensionMeta,
  BrowserExtensionGuide,
  browserExtensionSource,
);

export const DEFAULT_DOC_SLUG = "getting-started";

export const DOC_GROUPS = [
  { id: "start", label: "Start Here", pages: [gettingStarted, configuration, troubleshooting] },
  { id: "reference", label: "Reference", pages: [cli] },
  { id: "features", label: "Features", pages: [bases] },
  { id: "integrations", label: "Integrations", pages: [lsp, mcp, browserExtension] },
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
