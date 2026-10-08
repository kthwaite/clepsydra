# Inscribe: MEETING fields (TSK-murky-newt)

Branch `feature/inscribe-meeting-fields`. UI only.

## Scope (user rulings 2026-10-08)

- MEETING is the only kind that gets extra fields. 1:1 = MEETING + tag `1:1` (ADR 0006); no ONE_ON_ONE kind.
- Fields: **When** (`occurred_at`) and **Attendees** (`attendees`).
- `CreatePageRequest` already accepts both (`crates/clep-api/src/api/pages.rs`). No backend change, no schema regen.

## Design

- Fields render below Title only while `kind === "MEETING"`.
- When: defaults to the current local time, rounded down to the minute. Use the same datetime editing as `MeetingMeta` where it fits a form; a native `datetime-local` input is fine if `EditableCell` assumes commit-on-blur cell semantics. Send the value in the format `occurred_at` accepts (ISO date-time, no offset is fine).
- Attendees: `PersonCombo` (`onPick`, `exclude`) plus a removable chip list, as in `MeetingMeta`. Duplicate names (case-insensitive) are ignored.
- Body sends `attendees` (only when non-empty) and `occurred_at` only when kind is MEETING. Switching kind away hides the fields; their state is not sent.
- `reset()` clears both.
- Enter inside PersonCombo must not submit the form (same guard as ProjectCombo).

## TDD tasks

1. Tests first in `ui/src/components/codex/__tests__/InscribeModal.test.tsx`:
   - non-MEETING kind: no When/Attendees fields; body has no `attendees`/`occurred_at`.
   - MEETING: fields show; When prefilled; picking two people and submitting sends `attendees` + `occurred_at`.
   - removing a chip drops it; duplicate pick ignored.
   - MEETING → NOTE before submit: neither field sent.
   - Enter in the attendee combobox does not submit.
2. Implement in `InscribeModal.tsx` (extract a small `MeetingFields` component if the modal grows past readability).
3. Gates: `bun run typecheck`, `bun run lint`, `bun run test`.
