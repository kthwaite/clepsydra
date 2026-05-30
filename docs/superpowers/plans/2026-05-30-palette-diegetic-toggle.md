# Command-Palette Diegetic Toggle Implementation Plan (WU-9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **"Toggle diegetic chrome"** SYS command to the ⌘K command palette that flips the same `diegetic` ThemeProvider state used by the SettingsModal/STATUS toggle.

**Architecture:** Pure additive wiring in one component — pull `diegetic`/`setDiegetic` from the existing `useTheme()` hook and add one command object to the palette's `verbCommands` list. No new modules, no state, no API.

**Tech Stack:** React 19, the existing `ThemeProvider` (`useTheme()` exposes `diegetic: boolean` + `setDiegetic(on: boolean)`), TanStack Router, Tailwind v4.

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` → **WU-9**.

## Scope notes (verified against current code)

- `useTheme()` (in `ui/src/components/ThemeProvider.tsx`) returns `{ ..., diegetic, setDiegetic, ... }`. Toggling = `setDiegetic(!diegetic)`. The ticker/header/footer telemetry chrome is gated on `diegetic` in `CodexFrame.tsx`, so flipping it live-hides/shows the diegetic chrome — exactly what the SettingsModal/STATUS "diegetic-chrome" knob does.
- `ui/src/components/codex/CommandPalette.tsx` already pulls `const { toggle: toggleTheme } = useTheme();` (line 51) and has a flat `verbCommands` list (lines 89–151) holding the SYS-ish commands ("Toggle dark mode", "Re-run boot sequence" with hint `sys.boot`). We add the diegetic command there.
- The palette's `filtered` memo greps `verbCommands` by label/hint substring, so the new command is searchable via "diegetic"/"chrome".
- `CommandPalette.tsx` is NOT in the user's concurrent WIP — safe to edit. There is no pure-logic seam to unit-test (it's a one-object command wiring), so this plan verifies via build + a grep assertion + manual smoke, matching the project's pattern for UI-assembly changes (existing `CommandPalette.tsx` has no test).

## ⚠️ Concurrent-WIP git rule (applies to every task)

The working tree contains the user's unrelated in-flight WIP in many files. Touch ONLY `ui/src/components/codex/CommandPalette.tsx` and stage ONLY it (`git add ui/src/components/codex/CommandPalette.tsx`). NEVER `git add -A`/`.`/`ui/`. Do not modify/revert/stage any other file. Run `bun` commands from `ui/`. Baseline `bun run typecheck`/`lint` are CLEAN; the whole-tree build currently passes, so any new error referencing `CommandPalette.tsx` is yours; errors referencing other files are pre-existing WIP (do not touch).

---

## File structure

**Modify:**
- `ui/src/components/codex/CommandPalette.tsx` — pull `diegetic`/`setDiegetic` from `useTheme()`; add one `verbCommands` entry; add the two values to that memo's dep array.

---

## Task 1: Add the "Toggle diegetic chrome" command

**Files:**
- Modify: `ui/src/components/codex/CommandPalette.tsx`

- [ ] **Step 1: Pull `diegetic` + `setDiegetic` from `useTheme()`**

In `ui/src/components/codex/CommandPalette.tsx`, find:
```tsx
  const { toggle: toggleTheme } = useTheme();
```
replace with:
```tsx
  const { toggle: toggleTheme, diegetic, setDiegetic } = useTheme();
```

- [ ] **Step 2: Add the command to `verbCommands`**

In the `verbCommands` `useMemo` array, find the "Re-run boot sequence" entry:
```tsx
      {
        kind: "cmd",
        icon: "⟳",
        label: "Re-run boot sequence",
        hint: "sys.boot",
        action: () => runBoot(),
      },
```
and insert a new entry immediately BEFORE it (so the two SYS commands sit together), giving:
```tsx
      {
        kind: "cmd",
        icon: "◐",
        label: "Toggle diegetic chrome",
        hint: "sys.chrome",
        action: () => setDiegetic(!diegetic),
      },
      {
        kind: "cmd",
        icon: "⟳",
        label: "Re-run boot sequence",
        hint: "sys.boot",
        action: () => runBoot(),
      },
```

- [ ] **Step 3: Update the `verbCommands` memo dependency array**

The `verbCommands` `useMemo` ends with a deps array. Find:
```tsx
    [navigate, openTab, toggleTheme, openInscribe, openSettings, runBoot],
```
replace with:
```tsx
    [
      navigate,
      openTab,
      toggleTheme,
      openInscribe,
      openSettings,
      runBoot,
      diegetic,
      setDiegetic,
    ],
```

- [ ] **Step 4: Confirm the command is wired and the toggle reads live state**

Run: `cd ui && grep -nE "Toggle diegetic chrome|setDiegetic\(!diegetic\)|diegetic, setDiegetic" src/components/codex/CommandPalette.tsx`
Expected: three matches — the destructure (`toggle: toggleTheme, diegetic, setDiegetic`), the command label, and the `setDiegetic(!diegetic)` action.

- [ ] **Step 5: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass; no unused-symbol errors (both `diegetic` and `setDiegetic` are now used). Errors referencing OTHER files are the user's WIP — do not touch.

- [ ] **Step 6: Commit (stage ONLY CommandPalette.tsx)**

```bash
git add ui/src/components/codex/CommandPalette.tsx
git commit -m "feat(palette): add Toggle diegetic chrome SYS command"
```

---

## Task 2: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green (test count unchanged from baseline — no tests added).

- [ ] **Step 2: Manual smoke (dev server)**

Run `cd ui && bun run dev`, then:
- Press ⌘K to open the palette; type `diegetic` (or `chrome`) — confirm the **"Toggle diegetic chrome"** entry appears with the `sys.chrome` hint.
- Press Enter (or click it) — confirm the diegetic chrome toggles: the **Ticker** strip and the header/footer telemetry cells hide (when turning diegetic off) and reappear (when turning it back on).
- Re-open the palette and toggle again — confirm it flips back, and that the change matches the SettingsModal/STATUS "diegetic" knob (open Settings → Appearance and confirm the toggle state agrees).

- [ ] **Step 3: Stop the dev server** (Ctrl-C).

---

## Self-review (coverage map)

| WU-9 requirement | Task |
|---|---|
| "TOGGLE DIEGETIC CHROME" command in the palette's SYS group | Task 1 Steps 2–3 (inserted beside `sys.boot`) |
| Drives the same ThemeProvider state as SettingsModal/STATUS | Task 1 Step 1 (`setDiegetic` from `useTheme()`) + Step 2 action |
| Searchable / reachable | Inherent — `filtered` memo greps label/hint; verified in Task 2 manual smoke |
