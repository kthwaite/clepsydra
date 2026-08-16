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
- `GET /api/vault/archive/lookup` (pre-capture check)
- `GET /api/vault/index/tags` (tag suggestions)

## Build

From `extension/`:

```bash
bun install
bun run typecheck
bun run build          # Chromium (Manifest V3) -> dist/
bun run build:firefox  # Firefox (Manifest V2) -> dist-firefox/
bun run build:safari   # Safari (Manifest V3) -> dist-safari/
```

Build outputs:

- `extension/dist/` (Chrome/Chromium/Brave/Edge)
- `extension/dist-firefox/` (Firefox)
- `extension/dist-safari/` (Safari; same MV3 manifest as Chromium, built into
  its own directory so the Chromium watch build never overwrites it)

The runtime selects a native `browser` WebExtension namespace when present and
otherwise uses `chrome`; Safari provides both. Safari packaging and signing are
covered in [Install in Safari (macOS)](#install-in-safari-macos).

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

## Install in Safari (macOS)

Build the Safari bundle first:

```bash
cd extension
bun run build:safari
```

There are two install paths. The temporary path needs no Xcode and is the
fastest way to iterate; the Xcode path produces an install that survives
Safari relaunches and is the route to any real distribution.

### Temporary install (no Xcode, Safari 26+)

Safari 26 (macOS Tahoe) can load an extension folder directly, like Chrome's
"Load unpacked":

1. Safari > Settings > **Advanced** → check **"Show features for web
   developers"** (one-time).
2. Settings > **Developer** tab → click **"Add Temporary Extension…"** and
   authenticate when prompted.
3. Select the `extension/dist-safari` folder.

Safari switches to the Extensions tab and lists it under **Temporary**, with
controls to reload, reveal in Finder, or uninstall it.

> Note: temporary extensions are removed after 24 hours or when Safari quits.
> After a rebuild, use the extension's **reload** control rather than
> re-adding it.

### Persistent install (Xcode wrapper app)

Safari only runs non-temporary extensions that ship inside a signed macOS app,
so Apple's tooling wraps the WebExtension in a thin app you build once in
Xcode. Generate the wrapper project:

```bash
cd extension
bun run safari:xcode
```

This builds `dist-safari/`, then runs Apple's `xcrun
safari-web-extension-packager` (`--macos-only`, Swift, app name "Clepsydra Web
Archive", bundle id `app.clepsydra.Clepsydra-Web-Archive`) and writes the
project to
`extension/safari/Clepsydra Web Archive/`. Review the warnings it prints — the
packager lists any `manifest.json` keys the installed Safari does not support.

> The bundle id's last component must equal the app name with spaces replaced
> by hyphens. The packager (Xcode 26) derives the **app** target's id as
> `<given id minus its last component>.<App-Name>` while giving the **appex**
> `<given id>.Extension` verbatim — any other shape yields an appex id not
> prefixed by the app id, and Xcode refuses to embed it ("Embedded binary's
> bundle identifier is not prefixed with the parent app's bundle identifier").
Two warnings are expected and benign as of Safari 26:

- `notifications` — Safari has no `browser.notifications`; the service worker
  already guards for its absence, so capture/conflict notifications silently
  no-op (the popup still reports capture state).
- `type` — Safari ignores `background.type: "module"` and loads the worker as
  a classic script, which is fine because the built worker is a single
  self-contained file with no top-level `import`.

Two properties of the generated project matter for the workflow:

- **It references `dist-safari/` in place** (no `--copy-resources`), so every
  later `bun run build:safari` refreshes the extension payload without
  touching the Xcode project. Regenerating the project is never part of the
  edit loop. One caveat: the project references each *top-level* entry of
  `dist-safari/` by name (`background/`, `content/`, `manifest.json`,
  `webext.js`, …), so if a build ever adds or renames a top-level file or
  directory, the project must be regenerated to see it.
- **It holds your signing configuration**, which is why `safari:xcode`
  deliberately omits `--force`: it refuses to overwrite an existing
  `safari/` project. If you genuinely want a fresh one (e.g. to change the
  bundle identifier or add iOS), delete `extension/safari/` first and expect
  to redo the signing steps below. The project is gitignored — it is fully
  regenerable, and signing identity is machine-local anyway.

#### Signing and running in Xcode

1. Open `extension/safari/Clepsydra Web Archive/Clepsydra Web
   Archive.xcodeproj`.
2. Select the project in the navigator, then configure **each of the two
   targets** — the "Clepsydra Web Archive" app and the "Clepsydra Web Archive
   Extension" appex — under **Signing & Capabilities**:
   - **With an Apple ID in Xcode** (a free account's Personal Team is enough
     for local use): tick **"Automatically manage signing"** and pick your
     Team on both targets. Xcode provisions a development certificate and
     signs both. If the bundle id collides with something in your account,
     change it on both targets, keeping the appex id as the app id +
     `.Extension`.
   - **With no team at all**: leave the certificate as **"Sign to Run
     Locally"**. The build works, but Safari ignores locally-signed
     extensions unless "Allow unsigned extensions" is on (step 5).
3. **Product > Run** (⌘R) once. Launching the wrapper app is what registers
   the extension with Safari; you can quit the app immediately afterwards.
4. Safari > Settings > **Extensions** → enable **Clepsydra Web Archive**.
5. If it is not listed and you signed locally (no team), allow unsigned
   extensions: Settings > **Advanced** → "Show features for web developers",
   then Settings > **Developer** → check **"Allow unsigned extensions"**
   (authenticates, and resets every time Safari quits — recheck it each
   session; a team-signed build avoids this entirely).
6. Safari treats `host_permissions` as user-granted: on the first capture,
   grant access from the permission prompt or the extension's toolbar item —
   choose "Always Allow on Every Website" to match the Chromium behaviour.
   The options page's server status check needs the same grant for the
   server origin (e.g. `localhost`).

#### Updating after code changes

```bash
cd extension
bun run build:safari
```

Then in Xcode: **Product > Build** (⌘B) — a full Run is not needed; per
Apple's docs the rebuilt app bundle is picked up by Safari as soon as the
build completes. (For the temporary-install path, just hit the reload control
in Settings > Extensions instead.)

#### Distributing beyond this Mac

Unsigned/locally-signed builds are for development only. Shipping to other
machines requires an Apple Developer Program membership and either the App
Store, or — to distribute outside it — a Developer ID-signed and notarized
app. See Apple's [Distributing your Safari web
extension](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension).

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

Configured default tags are always included. The popup's Additional tags field applies only to the capture you are starting and does not change Settings. After capture, ordinary tags can be added or removed from the archived Folio; its captured body and snapshot remain protected.

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

- Safari rebuild and reload:

`bun run dev` does not update `extension/dist-safari/` either. Rebuild with
`bun run build:safari`, then either hit the extension's reload control in
Safari's Settings > Extensions (temporary install) or **Product > Build** in
Xcode (wrapper-app install).

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
