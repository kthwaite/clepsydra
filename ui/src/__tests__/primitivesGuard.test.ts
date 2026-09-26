import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "..");
const uiDir = path.join(src, "components/ui");

/** Files deliberately outside the guard (none since phase 4.1). */
const OUT_OF_SCOPE = new Set<string>([]);

/** Not yet restyled; each task removes its files. `it.fails` makes a file
 *  that is already clean fail, forcing its removal here. */
const PENDING = new Set<string>([]);

/** Tasking board screen (phase 4.3). */
const TASKING_FILES = [
  "../tasking/BoardHeader.tsx",
  "../filters/FilterBar.tsx",
  "../tasking/ScopeRail.tsx",
  "../tasking/KanbanView.tsx",
  "../tasking/TaskCard.tsx",
  "../tasking/QuickAddRow.tsx",
  "../tasking/board-constants.tsx",
  "../tasking/board-presentation.tsx",
  "../tasking/TaskingScreen.tsx",
  "../tasking/BoardModalFrame.tsx",
];

/** Slate prose elements restyled in phase 4.4a. */
const PROSE_FILES = [
  "../../editor/schema/elements/heading.tsx",
  "../../editor/schema/elements/blockquote.tsx",
];

/** Folio screen (phase 4.4a). */
const FOLIO_FILES = [
  "../codex/Folio.tsx",
  "../codex/FolioProperties.tsx",
  "../codex/FolioError.tsx",
  "../codex/FolioNotFound.tsx",
  "../codex/FolioLauncher.tsx",
  "../codex/KindSelect.tsx",
  "../codex/ProjectCombo.tsx",
  "../../editor/PageEditorHeader.tsx",
];

/** Screens restyled in phase 4; guarded like the primitives. */
const SCREEN_FILES = [
  "../codex/Atrium.tsx",
  "../codex/AgendaTile.tsx",
  "../codex/FeedRiverPanel.tsx",
  "../codex/SkyCard.tsx",
  "../codex/ActivityHeatmap.tsx",
  "../codex/ReadingContinues.tsx",
  "../codex/MoonDisc.tsx",
  "../codex/DayArc.tsx",
  "../codex/FeedRiver.tsx",
  "../codex/Gazetteer.tsx",
];

/** Bases (phase 4.5b). */
const BASES_FILES = [
  "../bases/BaseTableView.tsx",
  "../bases/BaseTable.tsx",
  "../bases/BasePickers.tsx",
  "../bases/FieldsPopover.tsx",
  "../bases/ViewOverridesStrip.tsx",
  "../bases/EditableCell.tsx",
  "../bases/BaseMemberDraft.tsx",
  "../bases/BasesIndex.tsx",
  "../bases/CreateBaseDialog.tsx",
  "../../routes/bases.$slug.tsx",
];

/** Mobile companion shell (phase 4b-1). */
const MOBILE_FILES = [
  "../codex/MobileCodexFrame.tsx",
  "../codex/StatusDot.tsx",
  "../codex/OpenPagesSheet.tsx",
  "../codex/MobileGoTo.tsx",
  "../codex/ContentsBadge.tsx",
];

const FORBIDDEN: Array<[string, RegExp]> = [
  ["uppercase", /\buppercase\b/],
  // Negative tracking tightens large serif display type (mockup); Vessel's
  // chrome was positive tracking on caps.
  ["tracking", /\btracking-(?!\[-)/],
  ["cl-mono", /\bcl-mono\b/],
  ["cl-serif", /\bcl-serif\b/],
  ["font-mono", /\bfont-mono\b/],
  ["border-ink", /\bborder-ink\b/],
  ["border-[…]", /\bborder-\[/],
  ["border-rule", /\bborder-rule\b/],
  ["border-border", /\bborder-border\b/],
  ["bare border", /["'\s]border["'\s]/],
  // Unprefixed only: a breakpoint variant (max-md:rounded-none for a
  // full-screen mobile sheet) is a layout choice, not Vessel chrome.
  ["rounded-none", /(^|["'\s])rounded-none\b/],
  ["9–11px type", /\btext-\[(9|10|11)px\]/],
  ["paper-2", /\bpaper-2\b/],
  ["ink-mute", /\bink-mute\b/],
  ["muted-foreground", /\bmuted-foreground\b/],
];

const files = [
  ...readdirSync(uiDir)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".stories."))
    .filter((f) => !OUT_OF_SCOPE.has(f)),
  "../codex/TabPreviewCard.tsx",
  "../codex/CodexModalShell.tsx",
  "../codex/CommandPalette.tsx",
  "../codex/Section.tsx",
  "../codex/Tick.tsx",
  ...SCREEN_FILES,
  ...TASKING_FILES,
  ...PROSE_FILES,
  ...FOLIO_FILES,
  ...BASES_FILES,
  ...MOBILE_FILES,
].filter((f) => {
  try {
    readFileSync(path.join(uiDir, f));
    return true;
  } catch {
    return false; // Section/Tick appear in Task 2
  }
});

function offences(file: string): string[] {
  const text = readFileSync(path.join(uiDir, file), "utf8");
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe("Stone & Lamp primitives carry no Vessel chrome", () => {
  for (const file of files) {
    const run = PENDING.has(file) ? it.fails : it;
    run(`${file} is clean`, () => {
      expect(offences(file)).toEqual([]);
    });
  }

  it("every pending file still exists", () => {
    for (const file of PENDING) {
      expect(files).toContain(file);
    }
  });
});
