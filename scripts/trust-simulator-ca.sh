#!/usr/bin/env bash
# Teach the booted iOS Simulator to trust the mkcert local CA.
#
# The iOS client is HTTPS-only with ordinary certificate validation and no ATS
# exception, so `clepsydra serve --tls` is unreachable from a simulator until
# that simulator's keychain holds the CA that signed the localhost cert. This
# installs it; the trust persists until the simulator is erased.
set -euo pipefail

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert not found. Install it first: brew install mkcert" >&2
  exit 1
fi

root_ca="$(mkcert -CAROOT)/rootCA.pem"
if [ ! -f "$root_ca" ]; then
  echo "No local CA at $root_ca. Create one with: mkcert -install" >&2
  exit 1
fi

# `simctl keychain booted` reports a generic failure when nothing is booted,
# which reads as a certificate problem rather than a missing simulator.
if ! xcrun simctl list devices booted | grep -q '(Booted)'; then
  echo "No booted simulator. Open one in Xcode (or: xcrun simctl boot '<device>')." >&2
  exit 1
fi

xcrun simctl keychain booted add-root-cert "$root_ca"
echo "Trusted $root_ca in the booted simulator."
