import type { ShortcutId } from "#/lib/shortcuts";

export type StaticCommandAction =
  | "navigate-atrium"
  | "open-today-journal"
  | "open-capture-aside"
  | "open-constellation"
  | "navigate-gazetteer"
  | "navigate-bases"
  | "navigate-academic"
  | "navigate-repairs"
  | "create-base"
  | "add-book"
  | "inscribe-folio"
  | "open-settings"
  | "toggle-theme"
  | "open-shortcut-help"
  | "toggle-diegetic-chrome"
  | "run-boot-sequence";

export interface StaticCommandDescriptor {
  readonly id: string;
  readonly title: string;
  readonly shortcut?: ShortcutId;
  readonly action: StaticCommandAction;
}

export const STATIC_COMMANDS: readonly StaticCommandDescriptor[] = [
  {
    id: "nav.atrium",
    title: "Open Atrium",
    shortcut: "nav.atrium",
    action: "navigate-atrium",
  },
  {
    id: "journal.today",
    title: "Today's journal",
    shortcut: "journal.today",
    action: "open-today-journal",
  },
  {
    id: "journal.capture",
    title: "Capture aside",
    shortcut: "journal.capture",
    action: "open-capture-aside",
  },
  {
    id: "nav.constellation",
    title: "Open Constellation (graph)",
    shortcut: "nav.constellation",
    action: "open-constellation",
  },
  {
    id: "nav.gazetteer",
    title: "Open Gazetteer (index)",
    shortcut: "nav.gazetteer",
    action: "navigate-gazetteer",
  },
  {
    id: "nav.bases",
    title: "Open Bases",
    action: "navigate-bases",
  },
  {
    id: "nav.academic",
    title: "Open Academic Library",
    action: "navigate-academic",
  },
  {
    id: "nav.repairs",
    title: "Open Reference Repairs",
    action: "navigate-repairs",
  },
  {
    id: "bases.create",
    title: "Create Base",
    action: "create-base",
  },
  {
    id: "library.add-book",
    title: "Add book by ISBN",
    action: "add-book",
  },
  {
    id: "app.inscribe",
    title: "Inscribe new folio",
    shortcut: "app.inscribe",
    action: "inscribe-folio",
  },
  {
    id: "app.settings",
    title: "Open Status / preferences",
    shortcut: "app.settings",
    action: "open-settings",
  },
  {
    id: "app.themeToggle",
    title: "Toggle dark mode",
    shortcut: "app.themeToggle",
    action: "toggle-theme",
  },
  {
    id: "app.shortcutHelp",
    title: "Keyboard shortcuts",
    shortcut: "app.shortcutHelp",
    action: "open-shortcut-help",
  },
  {
    id: "sys.chrome",
    title: "Toggle diegetic chrome",
    action: "toggle-diegetic-chrome",
  },
  {
    id: "sys.boot",
    title: "Re-run boot sequence",
    action: "run-boot-sequence",
  },
];
