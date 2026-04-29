# Codex Inquiry List · stub

**Status:** deferred (placed behind `VITE_ENABLE_PROSPECTIVE_PANELS` flag in Atrium/Diurnal)
**Why deferred:** requires a domain model that does not yet exist in the vault layer.

## What's needed
- A way to mark vault content as an "open question" (could be a tag like `#question`, a frontmatter field, or a dedicated `inquiry/` folder)
- An endpoint that returns open questions ordered by recency or weight
- The "Inquiry, open" panel (currently hardcoded ◇/◆ list) consumes this

## Open questions
- Tag-based, folder-based, or frontmatter-based?
- How are questions resolved — a flag, a status field, or by linking to an answer page?
- Should ◇ and ◆ encode different question states (open vs. urgent), or are those purely typographic?

## Touchpoints when this lands
- ui/src/components/codex/Atrium.tsx · the gated "Inquiry, open" panel
- ui/src/api/inquiry.ts · new hook
- src/api/inquiry_routes.rs · new endpoints
- src/vault/inquiry.rs · domain logic
