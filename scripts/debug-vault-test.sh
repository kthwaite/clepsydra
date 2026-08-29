#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
generator="$repo/scripts/debug-vault.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

destination="$tmp/vault"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_line() {
  local file="$1"
  local expected="$2"
  local line

  while IFS= read -r line; do
    if [[ "$line" == "$expected" ]]; then
      return 0
    fi
  done < "$file"

  fail "$file does not contain: $expected"
}

assert_page() {
  local relative_path="$1"
  local expected_id="$2"
  local file="$destination/$relative_path"
  local first_line
  local marker_count=0
  local line

  [[ -f "$file" ]] || fail "missing page: $relative_path"
  IFS= read -r first_line < "$file"
  [[ "$first_line" == "+++" ]] || fail "$relative_path does not start with TOML frontmatter"

  while IFS= read -r line; do
    if [[ "$line" == "+++" ]]; then
      marker_count=$((marker_count + 1))
    fi
  done < "$file"
  [[ "$marker_count" -eq 2 ]] || fail "$relative_path has $marker_count TOML frontmatter markers"

  assert_line "$file" "id = \"$expected_id\""
}

if "$generator" >/dev/null 2>&1; then
  fail "generator accepted a missing destination argument"
fi

"$generator" "$destination"

[[ -f "$destination/.clepsydra/config.toml" ]] || fail "missing initialized vault config"
[[ -d "$destination/.clepsydra/templates" ]] || fail "missing initialized templates directory"
[[ -d "$destination/_attachments" ]] || fail "missing initialized attachments directory"
assert_line "$destination/.clepsydra/config.toml" '[vault]'

fixtures=(
  'projects/debug-vault/20260829.debug-vault.DbgPrj01.md|019f1a2b-0000-7000-8000-000000000001'
  'notes/debug-vault/20260829.debug-overview.DbgNote1.md|019f1a2b-0000-7000-8000-000000000002'
  'notes/debug-vault/20260829.debug-details.DbgNote2.md|019f1a2b-0000-7000-8000-000000000003'
  'tasks/debug-vault/TSK-calm-heron-2xm9p.md|019f1a2b-0000-7000-8000-000000000004'
  'tasks/debug-vault/TSK-brisk-otter-3df6q.md|019f1a2b-0000-7000-8000-000000000005'
  'tasks/debug-vault/TSK-clear-raven-4gh7r.md|019f1a2b-0000-7000-8000-000000000006'
  'tasks/debug-vault/TSK-fresh-tiger-6mn9t.md|019f1a2b-0000-7000-8000-000000000007'
  'tasks/debug-vault/TSK-grand-wren-7pq2v.md|019f1a2b-0000-7000-8000-000000000008'
  'cycles/S-steady-finch-5jk8s.md|019f1a2b-0000-7000-8000-000000000009'
  'journals/20260829.2026-08-29.DbgJrnl1.md|019f1a2b-0000-7000-8000-00000000000a'
  'meetings/debug-vault/20260829.debug-standup.DbgMeet1.md|019f1a2b-0000-7000-8000-00000000000b'
)

for fixture in "${fixtures[@]}"; do
  IFS='|' read -r relative_path expected_id <<< "$fixture"
  assert_page "$relative_path" "$expected_id"
done

project="$destination/projects/debug-vault/20260829.debug-vault.DbgPrj01.md"
assert_line "$project" 'type = "PROJECT"'
assert_line "$project" 'project = "debug-vault"'
assert_line "$project" 'board = true'

note_overview="$destination/notes/debug-vault/20260829.debug-overview.DbgNote1.md"
note_details="$destination/notes/debug-vault/20260829.debug-details.DbgNote2.md"
assert_line "$note_overview" 'type = "NOTE"'
assert_line "$note_overview" 'See [[Debug Details]] for the fixture inventory.'
assert_line "$note_details" 'type = "NOTE"'
assert_line "$note_details" 'Return to [[Debug Overview]].'

task_paths=(
  'TSK-calm-heron-2xm9p.md|INTAKE|P0'
  'TSK-brisk-otter-3df6q.md|TRIAGE|P1'
  'TSK-clear-raven-4gh7r.md|FIELD|P2'
  'TSK-fresh-tiger-6mn9t.md|REVIEW|P3'
  'TSK-grand-wren-7pq2v.md|SEALED|P2'
)
for fixture in "${task_paths[@]}"; do
  IFS='|' read -r filename status priority <<< "$fixture"
  task="$destination/tasks/debug-vault/$filename"
  assert_line "$task" 'type = "TASK"'
  assert_line "$task" 'project = "debug-vault"'
  assert_line "$task" "status = \"$status\""
  assert_line "$task" "priority = \"$priority\""
done
assert_line "$destination/tasks/debug-vault/TSK-clear-raven-4gh7r.md" 'cycle = "S-steady-finch-5jk8s"'

cycle="$destination/cycles/S-steady-finch-5jk8s.md"
assert_line "$cycle" 'type = "CYCLE"'
assert_line "$cycle" 'state = "ACTIVE"'

journal="$destination/journals/20260829.2026-08-29.DbgJrnl1.md"
assert_line "$journal" 'type = "JOURNAL"'
assert_line "$journal" '- [ ] Exercise the debug vault [priority:: A]'

meeting="$destination/meetings/debug-vault/20260829.debug-standup.DbgMeet1.md"
assert_line "$meeting" 'type = "MEETING"'
assert_line "$meeting" 'attendees = ["[[Ada Lovelace]]", "[[Grace Hopper]]"]'

base="$destination/bases/debug-notes.base.toml"
[[ -f "$base" ]] || fail "missing Base definition"
assert_line "$base" 'name = "Debug Notes"'
assert_line "$base" 'all = [ { field = "project", op = "eq", value = "debug-vault" } ]'
assert_line "$base" 'layout = "table"'

feeds="$destination/feeds.md"
[[ -f "$feeds" ]] || fail "missing feed manifest"
assert_line "$feeds" '## Engineering #debug'
assert_line "$feeds" '- [Clepsydra Example](https://example.invalid/feed.xml) #fixture'

printf 'sentinel-before\n' > "$destination/sentinel"
if "$generator" "$destination" >"$tmp/second-run.out" 2>&1; then
  fail "generator accepted an initialized destination"
fi
[[ "$(cat "$destination/sentinel")" == 'sentinel-before' ]] || fail "second run modified sentinel"

printf 'PASS: debug vault fixture is initialized, deterministic, representative, and non-destructive\n'
