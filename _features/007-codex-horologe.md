# Codex Horologe · stub

**Status:** deferred (placed behind `VITE_ENABLE_PROSPECTIVE_PANELS` flag in Atrium/Diurnal)
**Why deferred:** requires a domain model that does not yet exist in the vault layer.

## What's needed
- A configured location (latitude, longitude) — likely under a new `[location]` section in `config.toml`
- An astronomical computation for sunrise/sunset (use the `suncalc` Rust crate or compute client-side via `suncalc-js`)
- The Horologe widget (currently hardcoded sunset 19:00) consumes this

## Open questions
- Is location configured per-vault or per-user? (per-vault aligns with the "personal codex" framing)
- Compute client-side (no network, no backend dependency) or server-side (consistent across devices)?
- What does the empty state look like before location is configured — keep the widget visible with `—`, or hide entirely?

## Touchpoints when this lands
- ui/src/components/codex/Atrium.tsx · the gated horologe `cl-frame`
- ui/src/api/horologe.ts · new hook (only if computed server-side)
- src/api/horologe_routes.rs · new endpoint (only if server-side)
- src/vault/config.rs · location section
