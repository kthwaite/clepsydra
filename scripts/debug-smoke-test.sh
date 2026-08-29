#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$(mktemp "${TMPDIR:-/tmp}/clepsydra-debug-smoke.XXXXXX")"
debug_pid=""
workspace=""

cleanup() {
  if [[ -n "$debug_pid" ]]; then
    kill -TERM -- "-$debug_pid" 2>/dev/null || true
    wait "$debug_pid" 2>/dev/null || true
  fi
  if [[ -n "$workspace" && -d "$workspace" ]]; then
    rm -rf "$workspace"
  fi
  rm -f "$log"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf '%s\n' '--- just debug output ---' >&2
  cat "$log" >&2
  exit 1
}

wait_for_url() {
  local url="$1"
  local deadline=$((SECONDS + 180))
  until curl --fail --silent --show-error "$url" >/dev/null 2>&1; do
    if ! kill -0 "$debug_pid" 2>/dev/null; then
      fail "just debug exited before $url became ready"
    fi
    if (( SECONDS >= deadline )); then
      fail "timed out waiting for $url"
    fi
    sleep 1
  done
}

cd "$repo"
set -m
just debug >"$log" 2>&1 &
debug_pid=$!
set +m

wait_for_url "http://127.0.0.1:3100/api/vault/index/stats"
wait_for_url "http://127.0.0.1:5174"

workspace_deadline=$((SECONDS + 10))
until workspace="$(sed -n 's/^Temporary workspace: //p' "$log")" && [[ -n "$workspace" ]]; do
  if (( SECONDS >= workspace_deadline )); then
    fail "debug output did not report the temporary workspace"
  fi
  sleep 1
done
[[ -d "$workspace" ]] || fail "reported temporary workspace does not exist: $workspace"

backend_pages="$(curl --fail --silent --show-error "http://127.0.0.1:3100/api/vault/pages")"
[[ "$backend_pages" == *'"title":"Debug Vault"'* ]] || fail "backend page listing does not expose seeded content"

proxy_pages="$(curl --fail --silent --show-error "http://127.0.0.1:5174/api/vault/pages")"
[[ "$proxy_pages" == *'"title":"Debug Vault"'* ]] || fail "Vite proxy does not expose seeded content"

frontend="$(curl --fail --silent --show-error "http://127.0.0.1:5174")"
[[ "$frontend" == *'/@vite/client'* ]] || fail "Vite frontend does not include the HMR client"

kill -TERM "$debug_pid"
wait "$debug_pid" 2>/dev/null || true
debug_pid=""

[[ ! -e "$workspace" ]] || fail "temporary workspace remains after shutdown: $workspace"
if curl --fail --silent --max-time 1 "http://127.0.0.1:3100/api/vault/index/stats" >/dev/null 2>&1; then
  fail "backend child remains after shutdown"
fi
if curl --fail --silent --max-time 1 "http://127.0.0.1:5174" >/dev/null 2>&1; then
  fail "Vite child remains after shutdown"
fi

printf 'PASS: debug services, seeded proxy data, HMR, and cleanup verified\n'
