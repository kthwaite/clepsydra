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
3. (Optional) Set default tags + notification preferences.
4. Click **Save**.
5. Confirm the status box shows **Connected**.

## Usage

- Open any page and click **Capture This Page** in the popup, or
- Use the command shortcut:
  - Windows/Linux: `Ctrl+Shift+S`
  - macOS: `Command+Shift+S`

## Dev workflow notes

- Watch build:

```bash
cd extension
bun run dev
```

- After code changes, reload the extension in your browser:
  - Chromium: extensions page -> **Reload**
  - Firefox: load temporary add-on again if needed

## Troubleshooting

- **“Server unreachable” in popup/options**
  - Verify server is running: `cargo run -- serve`
  - Verify `http://localhost:3000/api/vault/archive/status` is reachable
- **Capture doesn’t appear to run**
  - Reload extension after rebuild
  - Ensure you are on a normal web page (`http://` or `https://`)
- **Conflict notification (“Content Changed”)**
  - The URL already exists with different content; update behavior is controlled in extension settings
