#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/clepsydra-debug.XXXXXX")"
vault="$workspace/vault"
backend_pid=""
frontend_pid=""

terminate_group() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  terminate_group "$frontend_pid"
  terminate_group "$backend_pid"
  [[ -z "$frontend_pid" ]] || wait "$frontend_pid" 2>/dev/null || true
  [[ -z "$backend_pid" ]] || wait "$backend_pid" 2>/dev/null || true
  rm -rf "$workspace"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

"$repo/scripts/debug-vault.sh" "$vault"
cat >"$workspace/config.toml" <<'EOF'
[server]
host = "127.0.0.1"
port = 3100
dev_mode = true

[vault]
root = "./vault"
EOF

# Job control gives each background service its own process group. Cleanup can
# then stop cargo/bun and every child they start, not only the wrapper process.
set -m
(
  cd "$workspace"
  exec env \
    CLEPSYDRA__SERVER__HOST="127.0.0.1" \
    CLEPSYDRA__SERVER__DEV_MODE="true" \
    CLEPSYDRA__VAULT__ROOT="$vault" \
    cargo run --quiet --manifest-path "$repo/Cargo.toml" --bin clep -- serve --port 3100
) &
backend_pid=$!
(
  cd "$repo"
  exec env CLEPSYDRA_API_TARGET="http://127.0.0.1:3100" \
    bun run --cwd ui dev -- --host 127.0.0.1 --port 5174 --strictPort
) &
frontend_pid=$!
set +m

printf 'Backend: http://127.0.0.1:3100\n'
printf 'Frontend: http://127.0.0.1:5174\n'
printf 'Debug vault: %s\n' "$vault"
printf 'Temporary workspace: %s\n' "$workspace"

while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 1
done

status=0
if ! kill -0 "$backend_pid" 2>/dev/null; then
  wait "$backend_pid" || status=$?
  backend_pid=""
fi
if ! kill -0 "$frontend_pid" 2>/dev/null; then
  frontend_status=0
  wait "$frontend_pid" || frontend_status=$?
  frontend_pid=""
  if (( status == 0 )); then
    status=$frontend_status
  fi
fi
exit "$status"
