#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/clepsydra-debug.XXXXXX")"
vault="$workspace/vault"
requested_status=0
fixture_pid=""
fixture_group=""
backend_pid=""
backend_group=""
frontend_pid=""
frontend_group=""

request_exit() {
  if (( requested_status == 0 )); then
    requested_status="$1"
  fi
}

exit_if_requested() {
  if (( requested_status != 0 )); then
    exit "$requested_status"
  fi
}

group_alive() {
  local group="$1"
  [[ -n "$group" ]] && kill -0 -- "-$group" 2>/dev/null
}

any_group_alive() {
  group_alive "$fixture_group" ||
    group_alive "$backend_group" ||
    group_alive "$frontend_group"
}

signal_live_groups() {
  local signal="$1"
  local group
  for group in "$fixture_group" "$backend_group" "$frontend_group"; do
    if group_alive "$group"; then
      kill -"$signal" -- "-$group" 2>/dev/null || true
    fi
  done
}

wait_for_groups() {
  local seconds="$1"
  local deadline=$((SECONDS + seconds))
  while any_group_alive; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 0.1
  done
}

reap_child() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local initiating_status=$?
  local cleanup_failed=0
  local group
  trap - EXIT INT TERM HUP
  set +e

  signal_live_groups TERM
  if ! wait_for_groups 5; then
    signal_live_groups KILL
    if ! wait_for_groups 3; then
      cleanup_failed=1
    fi
  fi

  if ! reap_child "$fixture_pid"; then cleanup_failed=1; fi
  if ! reap_child "$backend_pid"; then cleanup_failed=1; fi
  if ! reap_child "$frontend_pid"; then cleanup_failed=1; fi

  for group in "$fixture_group" "$backend_group" "$frontend_group"; do
    if group_alive "$group"; then
      printf 'Cleanup failed: process group %s is still running\n' "$group" >&2
      cleanup_failed=1
    fi
  done

  if ! rm -rf -- "$workspace" || [[ -e "$workspace" ]]; then
    printf 'Cleanup failed: temporary workspace remains at %s\n' "$workspace" >&2
    cleanup_failed=1
  fi

  if (( initiating_status != 0 )); then
    exit "$initiating_status"
  fi
  if (( cleanup_failed != 0 )); then
    exit 1
  fi
  exit 0
}

trap cleanup EXIT
trap 'request_exit 130' INT
trap 'request_exit 143' TERM
trap 'request_exit 129' HUP

printf 'Debug vault: %s\n' "$vault"
printf 'Temporary workspace: %s\n' "$workspace"
mkdir -p "$workspace/home" "$workspace/xdg"

# Job control gives every managed command its own process group. A signal trap
# only records intent, so a pending trap cannot exit before the following $!
# assignment registers the group for cleanup.
set -m
"$repo/scripts/debug-vault.sh" "$vault" &
fixture_pid=$!
fixture_group=$fixture_pid
printf 'Fixture process group: %s\n' "$fixture_group"
exit_if_requested

while kill -0 "$fixture_pid" 2>/dev/null; do
  exit_if_requested
  sleep 0.1
done
fixture_status=0
wait "$fixture_pid" || fixture_status=$?
fixture_pid=""
exit_if_requested
if (( fixture_status != 0 )); then
  exit "$fixture_status"
fi

cat >"$workspace/config.toml" <<'EOF'
[server]
host = "127.0.0.1"
port = 3100
dev_mode = true

[vault]
root = "./vault"
EOF
exit_if_requested

(
  cd "$workspace"
  exec env \
    HOME="$workspace/home" \
    XDG_CONFIG_HOME="$workspace/xdg" \
    CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" \
    RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
    CLEPSYDRA__SERVER__HOST="127.0.0.1" \
    CLEPSYDRA__SERVER__DEV_MODE="true" \
    CLEPSYDRA__VAULT__ROOT="$vault" \
    cargo run --quiet --manifest-path "$repo/Cargo.toml" --bin clep -- serve --port 3100
) &
backend_pid=$!
backend_group=$backend_pid
printf 'Backend process group: %s\n' "$backend_group"
exit_if_requested

(
  cd "$repo"
  exec env CLEPSYDRA_API_TARGET="http://127.0.0.1:3100" \
    bun run --cwd ui dev -- --host 127.0.0.1 --port 5174 --strictPort
) &
frontend_pid=$!
frontend_group=$frontend_pid
printf 'Frontend process group: %s\n' "$frontend_group"
printf 'Backend: http://127.0.0.1:3100\n'
printf 'Frontend: http://127.0.0.1:5174\n'
set +m
exit_if_requested

while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  exit_if_requested
  sleep 0.1
done
exit_if_requested

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
