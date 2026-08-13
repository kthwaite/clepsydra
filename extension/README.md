# Clepsydra Web Archive Extension

Local development and install instructions for the browser extension.

## Prerequisites

- [Bun](https://bun.sh/) installed
- Clepsydra server running locally (from repo root):

```bash
cargo run -- serve
```

The extension expects these endpoints to be available:

- `GET /api/vault/archive/status`
- `POST /api/vault/archive`

## Build

From `extension/`:

```bash
bun install
bun run typecheck
bun run build          # Chromium (Manifest V3) -> dist/
bun run build:firefox  # Firefox (Manifest V2) -> dist-firefox/
```

Build outputs:

- `extension/dist/` (Chrome/Chromium/Brave/Edge)
- `extension/dist-firefox/` (Firefox)

## Install in Chrome / Chromium / Brave / Edge

1. Open extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select folder: `extension/dist`.
5. (Optional) Pin the extension in the browser toolbar.

## Install in Firefox (temporary dev install)

1. Build Firefox bundle first:

```bash
cd extension
bun run build:firefox
```

2. Open: `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on...**
4. Select: `extension/dist-firefox/manifest.json`

> Note: temporary add-ons are removed when Firefox restarts.

## First-time setup

1. Click the extension icon, then open **Settings**.
2. Set **Server URL** (default: `http://localhost:3000`).
3. (Optional) Set default tags, notification preferences, and the maximum
   resource size (default 100 MB). It should match the server's
   `archive.max_blob_size_mb`: a resource over this size is declined during
   capture, so the page is archived without it. There is no client-side
   control for the total capture budget — the server alone enforces
   `archive.max_request_size_mb` (default 250 MB) when the capture is
   ingested.
4. Click **Save**.
5. Confirm the status box shows **Connected**.

## Usage

- Open any page and click **Capture This Page** in the popup, or
- Use the command shortcut:
  - Windows/Linux: `Ctrl+Shift+S`
  - macOS: `Command+Shift+S`

## Dev workflow notes

- Chromium watch build:

```bash
cd extension
bun run dev
```

`bun run dev` watches only the Chromium bundle and writes changes to
`extension/dist/`. After a change, return to the Chromium extensions page and
select **Reload**.

- Firefox rebuild and reload:

`bun run dev` does not update `extension/dist-firefox/`. After every extension
code change you want to test in Firefox, rebuild before reloading:

```bash
cd extension
bun run build:firefox
```

Then reload the temporary add-on from
`about:debugging#/runtime/this-firefox`, loading it again if needed.

## Troubleshooting

- **“Server unreachable” in popup/options**
  - Verify server is running: `cargo run -- serve`
  - Verify `http://localhost:3000/api/vault/archive/status` is reachable
- **Capture doesn’t appear to run**
  - Reload extension after rebuild
  - The popup disables the capture button and explains why on pages that cannot
    be scripted (browser pages, the add-on store, `file://` without “Allow
    access to file URLs”)
- **“Capture In Progress”**
  - A capture for that URL is already running. Duplicate captures of the same
    page are suppressed rather than raced
- **Conflict notification (“Content Changed”)**
  - When `POST /api/vault/archive` returns `HTTP 409`, behaviour is notification
    only: the existing page is left untouched, and the notification names the
    vault path it lives at
  - Updating in place would need a server-side update endpoint; there is none
    today, so the extension deliberately exposes no conflict-resolution setting
