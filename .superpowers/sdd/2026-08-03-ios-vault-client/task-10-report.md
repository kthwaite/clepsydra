# Task 10 Report — End-to-End Tailscale Verification and Operational Setup

## Final status

**PARTIAL / BLOCKED.** The inherited Rust gates passed, and the bundled Tailscale backend CLI could report version, address, status, and certificate-help information. The system `tailscale` command was not on `PATH`. Certificate issuance failed with `operation not permitted` even when the output paths were under `/tmp`, and no certificate or key files were created. Consequently, the HTTPS server, certificate renewal, ACL enforcement, and physical-iPhone smoke scenario were not completed and must not be represented as successful.

This report is the only Task 10 artifact created in this assignment. No application code, README, configuration, or operational guide was modified.

## Verification checklist

### Step 1 — Automated verification gates

**Status: PARTIAL.** The following outcomes are inherited from the implementation-session evidence; no broad gate was rerun for this report.

| Command | Observed outcome |
|---|---|
| `cargo check --all-targets --all-features` | **PASS** |
| `cargo clippy --all-targets --all-features -- -D warnings` | **PASS** |
| `cargo test --all-features` | **PASS** |
| `bun run typecheck` from `ui/` | **PASS** |
| `bun run lint` from `ui/` | **Baseline failure** reported separately from the feature; no unrelated UI lint files were modified. |
| `bun run test` from `ui/` | **Baseline failure** reported separately from the feature; no unrelated UI test files were modified. |
| Extension checks | A later focused extension test **passed**. The inherited evidence does not establish a clean result for every requested extension typecheck/lint/test command, so those commands are not claimed as passing. |
| `swift test --package-path ios/Packages/ClepsydraMobileKit` | Prior Task 9 attempts reached `Build complete!` but timed out before test output; this is not a passing full-package result. |
| `xcodegen generate --spec ios/project.yml` | **PASS** in prior mobile verification; the project was generated successfully. |
| `xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` | **BLOCKED**: the requested iOS 26.2 simulator platform was not installed. |

The baseline UI lint/test failures and the mobile environment limitation are distinct from the Rust passes. No claim is made that all Step 1 gates passed.

### Step 2 — Tailnet-only HTTPS endpoint

**Status: BLOCKED.**

The following system-CLI probes all returned `command not found` because `tailscale` was absent from `PATH`:

```text
command -v tailscale                         -> command not found
tailscale version                            -> command not found
tailscale ip -4                              -> command not found
tailscale status --json                      -> command not found
tailscale cert --help                        -> command not found
```

The bundled application CLI was then invoked with its backend-CLI mode enabled. These probes succeeded:

```text
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale version
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale status --json
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale cert --help
```

The certificate request used the task's sample FQDN and writable temporary output paths:

```text
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale cert \
  --cert-file=/tmp/clepsydra-task10.crt \
  --key-file=/tmp/clepsydra-task10.key \
  clepsydra.tail-example.ts.net
```

Observed result: **FAIL**, `operation not permitted`. Neither `/tmp/clepsydra-task10.crt` nor `/tmp/clepsydra-task10.key` was created.

The server TLS implementation and existing configuration reference were inspected. They support an explicit `server.host`, port, `server.tls.enabled`, `server.tls.cert_path`, and `server.tls.key_path` pair. The current worktree still has no `docs/ios.md`, and the README/configuration links requested by the brief have not been added.

Because no usable certificate/key pair exists, these required outcomes were not observed:

- stable tailnet FQDN HTTPS endpoint;
- `clep serve` running with the Tailscale address, port `16667`, and explicit TLS files;
- successful HTTPS `/api/vault/uptime` request from another tailnet node;
- certificate renewal and post-renewal restart.

### Step 3 — Restrictive Tailscale policy and ACL verification

**Status: BLOCKED / NOT RUN.** No ACL was changed. No authorized-device or unauthorized-identity connection test was performed. The endpoint and certificate prerequisites in Step 2 were unavailable, so testing TCP `16667` would not have verified the requested policy. There is no evidence that Clepsydra was bound to `0.0.0.0`, and no router-authentication substitute was introduced.

### Step 4 — Physical-iPhone smoke scenario

**Status: BLOCKED / NOT RUN.** No physical-device evidence exists. In particular, the following were not observed on an iPhone over cellular data with Tailscale connected:

1. connection to the MagicDNS HTTPS URL;
2. search and open of an existing body token;
3. edit/save with exact Markdown verification on the Mac;
4. conflict detection while preserving the Mac edit;
5. manual keep-draft/reload/reconcile/save against a new revision;
6. note creation with canonical filename, Markdown contents, and Mac-side searchability.

Simulator, package, unit-test, or focused extension evidence cannot substitute for this physical-device checklist.

### Step 5 — Operational guide

**Status: BLOCKED / NOT IMPLEMENTED.** The brief requires `docs/ios.md` only after the smoke scenario works. The endpoint, ACL, certificate, and physical-device prerequisites did not work, and this assignment explicitly permits creating the report only. Therefore `docs/ios.md`, its README link, and the TLS-section link in `docs/configuration.md` were intentionally not created or changed.

The eventual guide must cover prerequisites, XcodeGen, signing/team selection, app setup, tailnet binding, certificate generation, the 90-day lifetime, renewal with the same certificate/key paths, server restart, ACL verification, and troubleshooting for unreachable server, expired certificate, and conflict responses.

### Step 6 — Documentation-sensitive checks

**Status: NOT RUN / BLOCKED.** The required documentation changes do not exist, so there was no documentation-sensitive revision to verify. Broad tests were not rerun, per assignment instructions. The Step 1 inherited results above are the only verification evidence; they must not be relabeled as a clean post-documentation run.

### Step 7 — Operational-setup commit

**Status: NOT RUN.** The brief's expected commit:

```text
git add docs/ios.md docs/configuration.md README.md
git commit -m "docs: add iPhone Tailscale setup"
```

was not run because those documentation changes were not completed. This assignment creates and commits this report only.

### Step 8 — Review and integration

**Status: NOT RUN / OUT OF SCOPE.** Task-by-task review and integration into the project's integration branch were not performed by this report-only assignment. No claim is made that the ten focused commits have been merged.

## Secure next commands

Run these only after MagicDNS and HTTPS have been enabled for the tailnet and the operator has confirmed the device/account context. Keep the certificate private key local; do not paste it into logs, tickets, or chat.

```bash
TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
export TAILSCALE_BE_CLI=1

"$TAILSCALE" ip -4
umask 077
CERT_DIR="$HOME/.config/clepsydra/tailscale"
install -d -m 700 "$CERT_DIR"

# Set FQDN to the actual MagicDNS name; do not use the sample name blindly.
FQDN='clepsydra.<tailnet>.ts.net'
"$TAILSCALE" cert \
  --cert-file="$CERT_DIR/clepsydra.crt" \
  --key-file="$CERT_DIR/clepsydra.key" \
  "$FQDN"
chmod 600 "$CERT_DIR/clepsydra.key"
chmod 644 "$CERT_DIR/clepsydra.crt"
```

If the bundled certificate command still returns `operation not permitted`, stop rather than weakening permissions or using `sudo`; resolve the Tailscale app/backend authorization and tailnet HTTPS setting first. Then configure the server without exposing the key:

```bash
export CLEPSYDRA__SERVER__HOST="$("$TAILSCALE" ip -4)"
export CLEPSYDRA__SERVER__PORT=16667
export CLEPSYDRA__SERVER__TLS__ENABLED=true
export CLEPSYDRA__SERVER__TLS__CERT_PATH="$CERT_DIR/clepsydra.crt"
export CLEPSYDRA__SERVER__TLS__KEY_PATH="$CERT_DIR/clepsydra.key"
cargo run -- serve
```

From an authorized tailnet node, verify the exact HTTPS endpoint and uptime route with the public certificate only:

```bash
curl --fail --silent --show-error \
  --cacert "$CERT_DIR/clepsydra.crt" \
  "https://$FQDN:16667/api/vault/uptime"
```

Apply the restrictive tailnet ACL in the Tailscale admin policy editor before exposing the service, then verify both an intended identity (expected success) and a non-authorized identity (expected denial). Do not bind Clepsydra to `0.0.0.0`; do not replace the tailnet restriction with router authentication.

After the physical-iPhone scenario passes, create the operational guide and rerun the narrow documentation-sensitive checks required by the brief. Certificate renewal must reuse the same `--cert-file` and `--key-file` paths, preserve key-file permissions, restart Clepsydra, and repeat the HTTPS uptime and ACL checks.

## Concerns

- The primary blocker is certificate issuance: the bundled CLI worked for read-only probes but failed to write certificates with `operation not permitted`, including under `/tmp`.
- The system CLI is not available through `PATH`; use the bundled path only after resolving the backend authorization issue.
- A physical iPhone and a second tailnet identity are required for Steps 3–4; no simulator or unit-test result can satisfy them.
- The iOS simulator build remains environment-blocked by the missing iOS 26.2 platform, and the full Swift package test invocation previously timed out after build completion.
- Existing UI baseline lint/test failures remain separately recorded; no unrelated UI or extension files were changed.
