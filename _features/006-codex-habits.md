# Codex Habits · stub

**Status:** deferred (placed behind `VITE_ENABLE_PROSPECTIVE_PANELS` flag in Atrium/Diurnal)
**Why deferred:** requires a domain model that does not yet exist in the vault layer.

## What's needed
- A habits model (id, name, cadence, target streak)
- A daily-completion record per habit
- An endpoint that returns today's habits with their recent streak history
- The Diurnal "Habits, this day" rail consumes this

## Open questions
- Are habit completions stored as a separate table, or embedded in the journal page's frontmatter?
- Visual encoding: ten-pip strip is the current placeholder — is that the canonical aggregate (last 10 days), or something else?
- What's the affordance for completing a habit — UI button on the rail, or only via journal frontmatter?

## Touchpoints when this lands
- ui/src/components/codex/Diurnal.tsx · the now-empty habits rail
- ui/src/api/habits.ts · new hook
- src/api/habits_routes.rs · new endpoints
- src/vault/habits.rs · domain logic
