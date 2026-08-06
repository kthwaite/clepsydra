# Codex Reading Log

**Status:** answered by reference — implemented on the bases system
(`docs/superpowers/specs/2026-08-06-bases-design.md`, §10 Pilot).

## Resolution of the open questions

- **Are books vault pages or a separate model?** BOOK pages with declared
  properties. No separate table: the generic `page_properties` index and the
  `bases/reading.base.toml` schema replace the bespoke `books` model.
- **How is progress recorded?** A `progress` property patch
  (`PATCH /api/vault/pages/by-id/{id}/properties`) — from the Atrium panel's
  advance affordance, the `/bases/reading` table, or Neovim directly.
- **Active vs. queued/finished?** The panel consumes the base's `Continues`
  view (`status = "reading"`); the full shelf lives in the `/bases/reading`
  table's other views.

## Touchpoints (as landed)

- `ui/src/components/codex/ReadingContinues.tsx` — the Atrium panel,
  consuming `GET /api/vault/bases/reading/views/continues`
- `ui/src/api/bases.ts` — view + property-patch hooks
- `src/api/bases.rs` / `src/api/properties.rs` — the generic endpoints
- vault `bases/reading.base.toml` — the schema (see the spec §3 for the
  reference file; it lives in the vault, not this repo)

The panel renders nothing until the vault carries a `reading` base with a
`Continues` view, so vaults without one see no change.
