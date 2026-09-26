# Stone & Lamp Phase 5.3 — Folio and editor rest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the remaining Folio and editor surfaces — editor blocks, editor popovers and link previews, journal/meeting/recipe page chrome, locked/protection dialogs and Inscribe — to Stone & Lamp per the approved phase 5 mockups.

**Architecture:** Presentation work across `ui/src/editor/**` and Folio-adjacent `ui/src/components/codex/*`. One approved copy change: Inscribe's "▣ commit to archive" becomes "Inscribe" with the subtitle "Kind and project decide where it is filed". The guard gets a `FOLIO_5_3_FILES` list (38 files); offenders sit in `PENDING` until cleaned.

**Tech Stack:** React 19, Slate, Tailwind v4 tokens, react-aria-components, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§2, §3, §5.5, §5.6 Folio).

**Mockups:** canvas row p5r3 — `FolioBlocks`, `FolioJournalMeeting`, `FolioRecipe`, `FolioLocked`, `Inscribe` (.dc.html in the session scratchpad `canvas5/project/`).

## Global Constraints
- Tokens only; `faint` decoration only; `rule` Sheaf only; no hex literals.
- Geist UI/meta; Instrument Serif titles/italic eyebrows with `Tick`; JetBrains Mono ONLY for code blocks, inline code, and source textareas marked `data-code-editor`.
- Sentence case; no uppercase/positive tracking/9–11px type/border separators/cl-mono/cl-serif/font-mono/paper-2/ink-mute/Vessel vars/cl-btn.
- Buttons via `ui/button`; overlays raise, 16–18px radius, shadow.
- Vessel-copy test assertions rewritten, not dropped. Behaviour, payloads, aria, keyboard unchanged unless named.
- Approved rulings: no callout element (none exists); Inscribe copy change above; locked + archive states as mocked.

## Review Focus
1. Code blocks: language picker, copy, mono body, line wrap — keyboard and Slate selection unaffected.
2. Popovers inside the editor (slash, wikilink, block-ref, task property, selection bubble) keep focus/selection behaviour — restyle only.
3. Locked Folio: unlock flow, wrong-passphrase error, and encryption setup dialog states all restyled with errors in `hot`, no information lost.
4. Journal/meeting meta: attendee chips / person combo keyboard behaviour unchanged.
5. Inscribe modal: rename doesn't break shortcuts (⌘↵) or tests pinning the old label.

---
### Task 1: Guard — DONE in setup.
### Task 2: Editor blocks (A) — CodeBlockElement, CodeLangPicker, schema/elements/{table,list,journalTime,footnoteDef,conversationTurn,image,thematicBreak}, elements/{LinkElement,WikilinkElement,MathElement (+data-code-editor on its LaTeX textarea),FootnoteRefElement,renderLeaf,LiveBaseTemplate}. Mockup FolioBlocks.
### Task 3: Editor popovers + link previews (B) — TaskPropertyPopover, SelectionBubbleMenu, MissingWikilinkPopover, WikilinkInlineEditor, WikilinkCombobox, SlashCombobox, BlockRefCombobox, vim/VimStatusBar, codex/{PreviewMarkdown,PreviewBody,LinkPreviewLayer,CLink,SheafContextMenu}. Mockup FolioBlocks (+ Main for popovers).
### Task 4: Page kinds (C) — codex/{JournalMeta,MeetingMeta,PersonCombo,recipe/RecipeFolioBody,RawMarkdownEditor}; KindSelect shows `kindDisplayLabel` (sentence case) not KIND_META caps; ProjectCombo empty state without "∅". Mockups FolioJournalMeeting, FolioRecipe.
### Task 5: Locked, protection, Inscribe (D) — codex/{LockedFolio,NoteProtectionDialog,EncryptionSetupDialog,InscribeModal,CaptureAsideModal}. Mockups FolioLocked, Inscribe. Failing test first for the Inscribe label + subtitle.
### Task 6: Integrate — empty PENDING, gates, knip diff, docs for changed labels, smoke.
