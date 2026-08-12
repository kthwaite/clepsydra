import type { DocPage } from "#/docs/types";

export type DocSlug = DocPage["slug"];

export type DocumentationDisposition =
  | { kind: "guide"; slug: DocSlug }
  | { kind: "reference"; slug: DocSlug }
  | { kind: "internal"; rationale: string };

export interface FeatureInventoryEntry {
  id: string;
  label: string;
  surface: "route" | "command" | "workflow" | "integration" | "settings";
  disposition: DocumentationDisposition;
}

export const FEATURE_INVENTORY = [
  {
    id: "/",
    label: "Atrium",
    surface: "route",
    disposition: { kind: "guide", slug: "getting-started" },
  },
  {
    id: "/academic",
    label: "Academic library",
    surface: "route",
    disposition: { kind: "guide", slug: "academic-library-and-reading" },
  },
  {
    id: "/agenda",
    label: "Agenda",
    surface: "route",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "/docs",
    label: "Documentation shell",
    surface: "route",
    disposition: {
      kind: "internal",
      rationale:
        "The documentation index is navigation for the guides themselves, not an application workflow that needs separate documentation.",
    },
  },
  {
    id: "/feeds",
    label: "Feed reader",
    surface: "route",
    disposition: { kind: "guide", slug: "capture-feeds-and-archives" },
  },
  {
    id: "/gazetteer",
    label: "Gazetteer",
    surface: "route",
    disposition: { kind: "guide", slug: "getting-started" },
  },
  {
    id: "/graph",
    label: "Constellation graph",
    surface: "route",
    disposition: { kind: "guide", slug: "links-search-graph-and-repair" },
  },
  {
    id: "/repairs",
    label: "Reference repairs",
    surface: "route",
    disposition: { kind: "guide", slug: "links-search-graph-and-repair" },
  },
  {
    id: "/tasking",
    label: "Tasking workspace",
    surface: "route",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "/workspace",
    label: "Workspace shell",
    surface: "route",
    disposition: {
      kind: "internal",
      rationale:
        "This route only restores and hosts tab state; page editing and navigation are documented as workflows rather than as a shell URL.",
    },
  },
  {
    id: "/bases/",
    label: "Bases index",
    surface: "route",
    disposition: { kind: "guide", slug: "bases" },
  },
  {
    id: "/bases/$slug",
    label: "Saved Base view",
    surface: "route",
    disposition: { kind: "guide", slug: "bases" },
  },
  {
    id: "/bases/$slug/edit",
    label: "Base configuration workspace",
    surface: "route",
    disposition: { kind: "guide", slug: "bases" },
  },
  {
    id: "/docs/$slug",
    label: "Generated documentation article route",
    surface: "route",
    disposition: {
      kind: "internal",
      rationale:
        "The slug route renders whichever registered guide was selected and is not an independently documentable feature.",
    },
  },
  {
    id: "/pages/$",
    label: "Folio page",
    surface: "route",
    disposition: { kind: "guide", slug: "pages-and-authoring" },
  },
  {
    id: "nav.atrium",
    label: "Open Atrium",
    surface: "command",
    disposition: { kind: "guide", slug: "getting-started" },
  },
  {
    id: "journal.today",
    label: "Open today's journal",
    surface: "command",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "journal.capture",
    label: "Capture aside",
    surface: "command",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "nav.constellation",
    label: "Open Constellation",
    surface: "command",
    disposition: { kind: "guide", slug: "links-search-graph-and-repair" },
  },
  {
    id: "nav.gazetteer",
    label: "Open Gazetteer",
    surface: "command",
    disposition: { kind: "guide", slug: "getting-started" },
  },
  {
    id: "nav.bases",
    label: "Open Bases",
    surface: "command",
    disposition: { kind: "guide", slug: "bases" },
  },
  {
    id: "nav.academic",
    label: "Open Academic library",
    surface: "command",
    disposition: { kind: "guide", slug: "academic-library-and-reading" },
  },
  {
    id: "nav.repairs",
    label: "Open reference repairs",
    surface: "command",
    disposition: { kind: "guide", slug: "links-search-graph-and-repair" },
  },
  {
    id: "bases.create",
    label: "Create Base",
    surface: "command",
    disposition: { kind: "guide", slug: "bases" },
  },
  {
    id: "library.add-book",
    label: "Add book by ISBN",
    surface: "command",
    disposition: { kind: "guide", slug: "books-and-reading" },
  },
  {
    id: "app.inscribe",
    label: "Inscribe new folio",
    surface: "command",
    disposition: { kind: "guide", slug: "pages-and-authoring" },
  },
  {
    id: "app.settings",
    label: "Open status and preferences",
    surface: "command",
    disposition: { kind: "reference", slug: "configuration" },
  },
  {
    id: "app.themeToggle",
    label: "Toggle dark mode",
    surface: "command",
    disposition: { kind: "reference", slug: "configuration" },
  },
  {
    id: "app.shortcutHelp",
    label: "Open keyboard shortcuts",
    surface: "command",
    disposition: { kind: "guide", slug: "getting-started" },
  },
  {
    id: "sys.chrome",
    label: "Toggle diegetic chrome",
    surface: "command",
    disposition: { kind: "reference", slug: "configuration" },
  },
  {
    id: "sys.boot",
    label: "Re-run boot sequence",
    surface: "command",
    disposition: {
      kind: "internal",
      rationale:
        "This command replays the decorative startup sequence for inspection; it does not perform application startup or recovery.",
    },
  },
  {
    id: "quire.new",
    label: "Create a Quire from the active folio",
    surface: "command",
    disposition: { kind: "guide", slug: "codex-and-conversation-capture" },
  },
  {
    id: "quire.add",
    label: "Add the active folio to a Quire",
    surface: "command",
    disposition: { kind: "guide", slug: "codex-and-conversation-capture" },
  },
  {
    id: "quire.remove",
    label: "Remove the active folio from its Quire",
    surface: "command",
    disposition: { kind: "guide", slug: "codex-and-conversation-capture" },
  },
  {
    id: "workflow.pages-editor",
    label: "Pages and editor",
    surface: "workflow",
    disposition: { kind: "guide", slug: "editor-workflows" },
  },
  {
    id: "workflow.folders-moves-deletes",
    label: "Folders, moves, and deletes",
    surface: "workflow",
    disposition: { kind: "guide", slug: "pages-and-authoring" },
  },
  {
    id: "workflow.search",
    label: "Search",
    surface: "workflow",
    disposition: { kind: "guide", slug: "links-search-graph-and-repair" },
  },
  {
    id: "workflow.wikilinks-backlinks",
    label: "Wikilinks and backlinks",
    surface: "workflow",
    disposition: { kind: "guide", slug: "links-search-graph-and-repair" },
  },
  {
    id: "workflow.graph",
    label: "Graph navigation",
    surface: "workflow",
    disposition: { kind: "guide", slug: "links-search-graph-and-repair" },
  },
  {
    id: "workflow.block-references-transclusion",
    label: "Block references and transclusion",
    surface: "workflow",
    disposition: { kind: "guide", slug: "block-references-and-transclusion" },
  },
  {
    id: "workflow.bases",
    label: "Bases",
    surface: "workflow",
    disposition: { kind: "guide", slug: "bases" },
  },
  {
    id: "workflow.tasks",
    label: "Tasks",
    surface: "workflow",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "workflow.agenda",
    label: "Agenda",
    surface: "workflow",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "workflow.journals",
    label: "Journals",
    surface: "workflow",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "workflow.board-cycles",
    label: "Board cycles",
    surface: "workflow",
    disposition: { kind: "guide", slug: "tasks-agenda-journals-and-board" },
  },
  {
    id: "workflow.academic-import",
    label: "Academic import",
    surface: "workflow",
    disposition: { kind: "guide", slug: "academic-library-and-reading" },
  },
  {
    id: "workflow.academic-library",
    label: "Academic library",
    surface: "workflow",
    disposition: { kind: "guide", slug: "academic-library-and-reading" },
  },
  {
    id: "workflow.reading",
    label: "Reading workflow",
    surface: "workflow",
    disposition: { kind: "guide", slug: "academic-library-and-reading" },
  },
  {
    id: "workflow.feeds",
    label: "Feeds",
    surface: "workflow",
    disposition: { kind: "guide", slug: "capture-feeds-and-archives" },
  },
  {
    id: "workflow.browser-capture",
    label: "Browser capture",
    surface: "integration",
    disposition: { kind: "guide", slug: "capture-feeds-and-archives" },
  },
  {
    id: "workflow.archive-cas",
    label: "Web archive and content-addressed storage",
    surface: "workflow",
    disposition: { kind: "guide", slug: "capture-feeds-and-archives" },
  },
  {
    id: "workflow.attachments",
    label: "Attachments",
    surface: "workflow",
    disposition: { kind: "guide", slug: "attachments-and-media" },
  },
  {
    id: "workflow.encryption",
    label: "Protected folios and encryption",
    surface: "workflow",
    disposition: { kind: "guide", slug: "encryption-and-protected-pages" },
  },
  {
    id: "workflow.codex",
    label: "Codex workspace",
    surface: "workflow",
    disposition: { kind: "guide", slug: "codex-and-conversation-capture" },
  },
  {
    id: "workflow.conversation-capture",
    label: "AI conversation capture",
    surface: "workflow",
    disposition: { kind: "guide", slug: "codex-and-conversation-capture" },
  },
  {
    id: "workflow.lsp",
    label: "Language Server Protocol",
    surface: "integration",
    disposition: { kind: "guide", slug: "lsp" },
  },
  {
    id: "workflow.mcp",
    label: "Model Context Protocol",
    surface: "integration",
    disposition: { kind: "guide", slug: "mcp" },
  },
  {
    id: "workflow.browser-extension",
    label: "Browser extension",
    surface: "integration",
    disposition: { kind: "guide", slug: "browser-extension" },
  },
  {
    id: "workflow.configuration",
    label: "Configuration",
    surface: "settings",
    disposition: { kind: "reference", slug: "configuration" },
  },
  {
    id: "workflow.diagnostics",
    label: "Diagnostics and reference repair",
    surface: "workflow",
    disposition: { kind: "reference", slug: "links-search-graph-and-repair" },
  },
  {
    id: "workflow.backup",
    label: "Vault backup",
    surface: "workflow",
    disposition: { kind: "guide", slug: "capture-feeds-and-archives" },
  },
] as const satisfies readonly FeatureInventoryEntry[];
