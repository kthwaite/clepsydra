# Plan — Atrium location: grey-out + populate affordance

Date: 2026-06-16
Branch: `feature/atrium-location` off `develop`

## Goal

The Atrium "Sky" card uses the configured vault location (`.clepsydra/location.toml`,
lat/long + optional label) for sunrise/sunset/light-left/day-arc. Location is currently
**read-only** (loaded once at startup into immutable `AppState.location`; frontend only
`GET`s it). Add:

1. Grey out the whole Sky card behind a CTA when no location is configured.
2. A modal to populate the location, supporting **three** inputs: manual lat/long + label,
   browser geolocation, and city-name search (backend Nominatim proxy → candidate list).
3. Live apply: saving persists to `location.toml` **and** updates in-memory state; the
   Atrium refetches and updates without a restart.

## Locked decisions

- Inputs: manual + browser-geolocation + city geocoding (all three).
- Grey-out: whole Sky card.
- Apply: live (mutable in-memory state).
- Geocode: backend proxy `GET /api/vault/geocode?q=` → Nominatim (reqwest already a dep).
- Disambiguation: show a short candidate list to pick from.
- Frontend uses raw `fetch` (mirroring existing `useLocation`) — no `schema.d.ts` regen needed.
- No "clear/unset" in MVP; the edit affordance covers changing an existing value.
- Reuse existing tokens/classes; **do not** edit `main.css` (it has unrelated WIP).

## API contract

### `PUT /api/vault/location`
Request: `{ "latitude": f64, "longitude": f64, "label": string | null }`
- 200 → `LocationResponse { latitude, longitude, label }` (the now-current value)
- 400 → latitude ∉ [-90,90] or longitude ∉ [-180,180]
Side effects: writes `.clepsydra/location.toml`, updates `state.location` in memory.

### `GET /api/vault/geocode?q=<str>&limit=<n=5>`
- 200 → `{ "results": [ { "label": string, "latitude": f64, "longitude": f64 }, ... ] }`
- 400 → blank `q`
- 502 → upstream Nominatim failure
Backend calls Nominatim `/search?format=json&q=&limit=&addressdetails=0` with a descriptive
`User-Agent` (mirror `vault/import_doi.rs`). Nominatim returns lat/lon as strings → parse to f64;
`display_name` → label.

## Tasks (TDD: failing test → implement → pass)

### Backend (one subagent — shared files: `api/location.rs`, `api/mod.rs`, `api/openapi.rs`)

- **B1 — Mutable location state.**
  `src/api/mod.rs`: `location: parking_lot::RwLock<Option<Location>>`.
  Update the one reader (`api/location.rs:40`) to `state.location.read()`.
  Update all ~19 `AppState { … }` sites: `location: None,` → `location: RwLock::new(None),`
  (`src/lib.rs` shorthand `location,` → `location: RwLock::new(location),`; `src/lsp/test_support.rs`;
  all `tests/*.rs`). Existing GET tests still pass.

- **B2 — Vault write + serialize.** `src/vault/location.rs`:
  derive `Serialize` on `Location` with `#[serde(skip_serializing_if = "Option::is_none")]` on `label`;
  add `pub fn write_location(vault_root: &Path, loc: &Location) -> Result<(), String>`
  (`create_dir_all(.clepsydra)` + `toml::to_string_pretty` + `fs::write`).
  Tests: write→read round-trip; creates `.clepsydra`; `label: None` omitted from TOML.

- **B3 — `PUT /location` handler.** `src/api/location.rs`:
  `UpdateLocationRequest { latitude, longitude, label: Option<String> }`;
  `put_location` validates ranges (→ `ApiError::bad_request`), `write_location` (→ `internal` on IO),
  `*state.location.write() = Some(loc)`, returns current `LocationResponse`.
  Route: `.route("/location", get(get_location).put(put_location))` in `api/mod.rs`.
  Register in `api/openapi.rs`. Tests (`tests/api_test.rs`): valid PUT → 200 + subsequent GET reflects it
  + file written; out-of-range lat → 400.

- **B4 — Geocode proxy.**
  `src/vault/geocode.rs`: `GeocodeResult { label, latitude, longitude }`;
  `async fn geocode(client: &reqwest::Client, base_url: &str, q: &str, limit: u32) -> Result<Vec<GeocodeResult>, String>`
  (base_url param for testability, like `import_doi`). Tests: **wiremock** mock Nominatim →
  parses string lat/lon, maps display_name, handles empty array.
  `src/api/location.rs`: `geocode_search(State, Query{ q, limit? })` → 400 on blank q, calls
  `vault::geocode` with the Nominatim const base url, → 502 on upstream error.
  Route `.route("/geocode", get(geocode_search))`; register in openapi. Handler test: blank q → 400.

Backend gates: `cargo test`, `cargo clippy`, `cargo fmt`.

### Frontend (one subagent — new modal + Atrium + hooks + store + root mount)

- **F1 — API hooks** (`ui/src/api/location.ts`, raw fetch, mirror `useLocation`):
  `useUpdateLocation()` → `PUT /api/vault/location`, on success
  `qc.invalidateQueries({ queryKey: queryKeys.location.current })`;
  `useGeocode()` → `GET /api/vault/geocode?q=` returning candidate list. Types for request/response.
  Tests: mock global `fetch`; assert URL/method/body + invalidation.

- **F2 — UI store** (`ui/src/store/ui.ts`): add `isLocationOpen`, `openLocation`, `closeLocation`
  (mirror `isInscribeOpen`/`openInscribe`/`closeInscribe`).

- **F3 — LocationModal** (`ui/src/components/codex/LocationModal.tsx`): vessel-diegetic style
  (mirror `InscribeModal` custom overlay: scrim dismiss, Escape, `role="dialog"`, `cl-mono`,
  `border-ink`/`bg-paper`, a `FORM CLP-…` caption). Fields: latitude, longitude (number),
  label (text). "Use my current location" button → `navigator.geolocation.getCurrentPosition`
  fills lat/long. City search field → `useGeocode` → renders candidate list; selecting one fills
  all three fields. Save validates ranges, calls `useUpdateLocation`, closes on success; shows errors.
  Mount in `ui/src/routes/__root.tsx` alongside the other modals.
  Tests: renders when open; manual Save calls mutate with body; invalid range blocks Save;
  geocode candidate select fills fields; geolocation button fills coords (mock `navigator.geolocation`).

- **F4 — Atrium Sky card** (`ui/src/components/codex/Atrium.tsx`): when `!hasLoc`, grey the sky
  content (`opacity-40 pointer-events-none` + `text-ink-mute`) with a centered CTA overlay
  ("Set location" → `openLocation()`). When `hasLoc`, add an unobtrusive edit control in the card
  body → `openLocation()`. Tests: mock `useLocation` (none/set) + store; CTA shown + calls
  `openLocation` when unset; edit affordance shown when set.

Frontend gates: `cd ui && bun run typecheck && bun run lint && bun test`.

## Integration / completion

- Run the app, confirm: unset → greyed card + CTA; modal saves (manual / geolocation / city
  search); Sky card updates live without restart; reload persists (file written).
- Commit staging **only** this feature's files (leave unrelated WIP untouched); merge to `develop`.
