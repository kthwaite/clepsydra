#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/clepsydra-debug-smoke.XXXXXX")"
fake_bin="$test_root/bin"
real_cargo="$(command -v cargo)"
real_bun="$(command -v bun)"
mkdir -p "$fake_bin"

case_name=""
case_log=""
case_pid=""
case_status=""
case_workspace=""
fixture_group=""
backend_group=""
frontend_group=""

refresh_case_state() {
  [[ -f "$case_log" ]] || return 0
  [[ -n "$case_workspace" ]] || case_workspace="$(sed -n 's/^Temporary workspace: //p' "$case_log")"
  [[ -n "$fixture_group" ]] || fixture_group="$(sed -n 's/^Fixture process group: //p' "$case_log")"
  [[ -n "$backend_group" ]] || backend_group="$(sed -n 's/^Backend process group: //p' "$case_log")"
  [[ -n "$frontend_group" ]] || frontend_group="$(sed -n 's/^Frontend process group: //p' "$case_log")"
}

terminate_group() {
  local group="$1"
  [[ "$group" =~ ^[0-9]+$ ]] || return 0
  kill -TERM -- "-$group" 2>/dev/null || true
}

kill_group() {
  local group="$1"
  [[ "$group" =~ ^[0-9]+$ ]] || return 0
  kill -KILL -- "-$group" 2>/dev/null || true
}

cleanup_case() {
  refresh_case_state
  terminate_group "$fixture_group"
  terminate_group "$backend_group"
  terminate_group "$frontend_group"
  if [[ "$case_pid" =~ ^[0-9]+$ ]]; then
    terminate_group "$case_pid"
  fi
  sleep 1
  kill_group "$fixture_group"
  kill_group "$backend_group"
  kill_group "$frontend_group"
  if [[ "$case_pid" =~ ^[0-9]+$ ]]; then
    kill_group "$case_pid"
    wait "$case_pid" 2>/dev/null || true
  fi
  if [[ -n "$case_workspace" && -e "$case_workspace" ]]; then
    rm -rf "$case_workspace"
  fi
  [[ -z "$case_log" ]] || rm -f "$case_log"
}

cleanup() {
  cleanup_case
  rm -rf "$test_root"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL [%s]: %s\n' "$case_name" "$1" >&2
  if [[ -f "$case_log" ]]; then
    printf '%s\n' '--- just debug output ---' >&2
    cat "$case_log" >&2
  fi
  exit 1
}

reset_case() {
  case_name="$1"
  case_log="$(mktemp "$test_root/${case_name}.XXXXXX")"
  case_pid=""
  case_status=""
  case_workspace=""
  fixture_group=""
  backend_group=""
  frontend_group=""
}

start_case() {
  set -m
  "$@" >"$case_log" 2>&1 &
  case_pid=$!
  set +m
}

wait_for_log() {
  local pattern="$1"
  local deadline=$((SECONDS + 30))
  until sed -n "/$pattern/p" "$case_log" | read -r _; do
    if ! kill -0 "$case_pid" 2>/dev/null; then
      fail "just debug exited before output matched: $pattern"
    fi
    if (( SECONDS >= deadline )); then
      fail "timed out waiting for output: $pattern"
    fi
    sleep 1
  done
  refresh_case_state
}

wait_for_url() {
  local url="$1"
  local deadline=$((SECONDS + 180))
  until curl --fail --silent --show-error "$url" >/dev/null 2>&1; do
    if ! kill -0 "$case_pid" 2>/dev/null; then
      fail "just debug exited before $url became ready"
    fi
    if (( SECONDS >= deadline )); then
      fail "timed out waiting for $url"
    fi
    sleep 1
  done
}

collect_status() {
  local timeout_seconds="$1"
  local deadline=$((SECONDS + timeout_seconds))
  while kill -0 "$case_pid" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      fail "timed out waiting for just debug to exit"
    fi
    sleep 1
  done
  refresh_case_state
  set +e
  wait "$case_pid"
  case_status=$?
  set -e
  case_pid=""
}

require_group() {
  local label="$1"
  local group="$2"
  [[ "$group" =~ ^[0-9]+$ ]] || fail "missing $label process-group report"
}

assert_group_gone() {
  local label="$1"
  local group="$2"
  [[ "$group" =~ ^[0-9]+$ ]] || return 0
  if kill -0 -- "-$group" 2>/dev/null; then
    fail "$label process group remains after shutdown: $group"
  fi
}

assert_url_closed() {
  local label="$1"
  local url="$2"
  if curl --fail --silent --max-time 1 "$url" >/dev/null 2>&1; then
    fail "$label remains reachable after shutdown"
  fi
}

assert_case_cleaned() {
  refresh_case_state
  [[ -n "$case_workspace" ]] || fail "missing temporary-workspace report"
  [[ ! -e "$case_workspace" ]] || fail "temporary workspace remains after shutdown: $case_workspace"
  assert_group_gone "fixture" "$fixture_group"
  assert_group_gone "backend" "$backend_group"
  assert_group_gone "frontend" "$frontend_group"
  assert_url_closed "backend" "http://127.0.0.1:3100/api/vault/index/stats"
  assert_url_closed "Vite" "http://127.0.0.1:5174"
}

finish_case() {
  rm -f "$case_log"
  case_log=""
  case_workspace=""
  fixture_group=""
  backend_group=""
  frontend_group=""
}

cat >"$fake_bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

is_init=false
is_serve=false
for arg in "$@"; do
  [[ "$arg" == "init" ]] && is_init=true
  [[ "$arg" == "serve" ]] && is_serve=true
done

if $is_init && [[ -n "${DEBUG_SMOKE_INIT_MARKER:-}" ]]; then
  printf '%s\n' "$$" >"$DEBUG_SMOKE_INIT_MARKER"
  trap 'exit 143' TERM
  trap 'exit 130' INT
  while :; do sleep 1; done
fi

if $is_serve && [[ -n "${DEBUG_SMOKE_BACKEND_EXIT:-}" ]]; then
  deadline=$((SECONDS + 60))
  until curl --fail --silent "http://127.0.0.1:5174" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || exit 97
    sleep 1
  done
  exit "$DEBUG_SMOKE_BACKEND_EXIT"
fi

exec "$DEBUG_SMOKE_REAL_CARGO" "$@"
EOF

cat >"$fake_bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

is_dev=false
for arg in "$@"; do
  [[ "$arg" == "dev" ]] && is_dev=true
done

if $is_dev && [[ -n "${DEBUG_SMOKE_FRONTEND_EXIT:-}" ]]; then
  deadline=$((SECONDS + 60))
  until curl --fail --silent "http://127.0.0.1:3100/api/vault/index/stats" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || exit 98
    sleep 1
  done
  exit "$DEBUG_SMOKE_FRONTEND_EXIT"
fi

exec "$DEBUG_SMOKE_REAL_BUN" "$@"
EOF
chmod +x "$fake_bin/cargo" "$fake_bin/bun"
export DEBUG_SMOKE_REAL_CARGO="$real_cargo"
export DEBUG_SMOKE_REAL_BUN="$real_bun"

cd "$repo"

reset_case "term"
start_case just debug
wait_for_url "http://127.0.0.1:3100/api/vault/index/stats"
wait_for_url "http://127.0.0.1:5174"
wait_for_log '^Frontend process group: '
require_group "fixture" "$fixture_group"
require_group "backend" "$backend_group"
require_group "frontend" "$frontend_group"

backend_pages="$(curl --fail --silent --show-error "http://127.0.0.1:3100/api/vault/pages")"
[[ "$backend_pages" == *'"title":"Debug Vault"'* ]] || fail "backend page listing does not expose seeded content"
proxy_pages="$(curl --fail --silent --show-error "http://127.0.0.1:5174/api/vault/pages")"
[[ "$proxy_pages" == *'"title":"Debug Vault"'* ]] || fail "Vite proxy does not expose seeded content"
frontend="$(curl --fail --silent --show-error "http://127.0.0.1:5174")"
[[ "$frontend" == *'/@vite/client'* ]] || fail "Vite frontend does not include the HMR client"

kill -TERM "$case_pid"
collect_status 30
[[ "$case_status" -eq 143 ]] || fail "TERM returned $case_status instead of 143"
assert_case_cleaned
finish_case

reset_case "backend-exit"
start_case env PATH="$fake_bin:$PATH" DEBUG_SMOKE_BACKEND_EXIT=41 just debug
collect_status 90
[[ "$case_status" -eq 41 ]] || fail "backend exit returned $case_status instead of 41"
require_group "backend" "$backend_group"
require_group "frontend" "$frontend_group"
assert_case_cleaned
finish_case

reset_case "frontend-exit"
start_case env PATH="$fake_bin:$PATH" DEBUG_SMOKE_FRONTEND_EXIT=42 just debug
collect_status 90
[[ "$case_status" -eq 42 ]] || fail "frontend exit returned $case_status instead of 42"
require_group "backend" "$backend_group"
require_group "frontend" "$frontend_group"
assert_case_cleaned
finish_case

reset_case "early-int"
early_marker="$test_root/early-init.started"
start_case env PATH="$fake_bin:$PATH" DEBUG_SMOKE_INIT_MARKER="$early_marker" just debug
marker_deadline=$((SECONDS + 30))
until [[ -f "$early_marker" ]]; do
  if ! kill -0 "$case_pid" 2>/dev/null; then
    fail "just debug exited before the fixture initializer started"
  fi
  (( SECONDS < marker_deadline )) || fail "timed out waiting for fixture initializer"
  sleep 1
done
kill -INT -- "-$case_pid"
collect_status 30
[[ "$case_status" -eq 130 ]] || fail "early INT returned $case_status instead of 130"
require_group "fixture" "$fixture_group"
assert_case_cleaned
finish_case

printf 'PASS: debug services, proxy/HMR, signal status, child exits, and bounded cleanup verified\n'
