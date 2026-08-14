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
  | "navigate-rubbish"
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

export type QuireCommandFamilyDescriptor =
  | {
      readonly id: "quire.new";
      readonly title: string;
      readonly action: "create-quire";
    }
  | {
      readonly id: "quire.add";
      readonly title: string;
      readonly action: "add-to-quire";
    }
  | {
      readonly id: "quire.remove";
      readonly title: string;
      readonly action: "remove-from-quire";
    };

export type QuireCommandAction = QuireCommandFamilyDescriptor["action"];

export type RuntimeQuireCommandDescriptor =
  | {
      readonly familyId: "quire.new";
      readonly id: "quire.new";
      readonly title: string;
      readonly action: "create-quire";
    }
  | {
      readonly familyId: "quire.add";
      readonly id: `quire.add.${string}`;
      readonly title: string;
      readonly action: "add-to-quire";
      readonly quireId: string;
    }
  | {
      readonly familyId: "quire.remove";
      readonly id: "quire.remove";
      readonly title: string;
      readonly action: "remove-from-quire";
    };

export interface QuireCommandContext {
  readonly activeQuireId?: string;
  readonly quires: readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

export const QUIRE_COMMAND_FAMILIES: readonly QuireCommandFamilyDescriptor[] = [
  {
    id: "quire.new",
    title: "Quire: new from active folio",
    action: "create-quire",
  },
  {
    id: "quire.add",
    title: "Quire: add active folio to",
    action: "add-to-quire",
  },
  {
    id: "quire.remove",
    title: "Quire: remove active folio from quire",
    action: "remove-from-quire",
  },
];

export function runtimeQuireCommands({
  activeQuireId,
  quires,
}: QuireCommandContext): RuntimeQuireCommandDescriptor[] {
  const commands: RuntimeQuireCommandDescriptor[] = [];

  for (const family of QUIRE_COMMAND_FAMILIES) {
    switch (family.action) {
      case "create-quire":
        commands.push({
          familyId: family.id,
          id: family.id,
          title: family.title,
          action: family.action,
        });
        break;
      case "add-to-quire":
        for (const quire of quires) {
          if (quire.id === activeQuireId) continue;
          commands.push({
            familyId: family.id,
            id: `${family.id}.${quire.id}`,
            title: `${family.title} ${quire.name}`,
            action: family.action,
            quireId: quire.id,
          });
        }
        break;
      case "remove-from-quire":
        if (activeQuireId) {
          commands.push({
            familyId: family.id,
            id: family.id,
            title: family.title,
            action: family.action,
          });
        }
        break;
      default:
        family satisfies never;
    }
  }

  return commands;
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
    id: "nav.rubbish",
    title: "Open Rubbish Bin",
    action: "navigate-rubbish",
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
