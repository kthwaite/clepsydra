#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  printf 'usage: %s <destination>\n' "$(basename "$0")" >&2
  exit 64
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="$1"

cargo run --quiet --manifest-path "$repo/Cargo.toml" --bin clep -- init "$destination"

mkdir -p \
  "$destination/projects/debug-vault" \
  "$destination/notes/debug-vault" \
  "$destination/tasks/debug-vault" \
  "$destination/cycles" \
  "$destination/journals" \
  "$destination/meetings/debug-vault" \
  "$destination/bases"

cat > "$destination/projects/debug-vault/20260829.debug-vault.DbgPrj01.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000001"
title = "Debug Vault"
type = "PROJECT"
project = "debug-vault"
board = true
health = "GREEN"
lead = "Fixture Maintainer"
target = "Representative local development"
tags = ["debug", "fixture"]
created_at = 2026-08-29T09:00:00Z
updated_at = 2026-08-29T09:00:00Z
+++
# Debug Vault

A deterministic project for local development. Start with [[Debug Overview]].
EOF

cat > "$destination/notes/debug-vault/20260829.debug-overview.DbgNote1.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000002"
title = "Debug Overview"
type = "NOTE"
project = "debug-vault"
tags = ["debug", "overview"]
created_at = 2026-08-29T09:05:00Z
updated_at = 2026-08-29T09:05:00Z
+++
# Debug Overview

See [[Debug Details]] for the fixture inventory.
EOF

cat > "$destination/notes/debug-vault/20260829.debug-details.DbgNote2.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000003"
title = "Debug Details"
type = "NOTE"
project = "debug-vault"
tags = ["debug", "reference"]
created_at = 2026-08-29T09:10:00Z
updated_at = 2026-08-29T09:10:00Z
+++
# Debug Details

Return to [[Debug Overview]].
EOF

cat > "$destination/tasks/debug-vault/TSK-calm-heron-2xm9p.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000004"
title = "Triage fixture feedback"
type = "TASK"
project = "debug-vault"
status = "INTAKE"
priority = "P0"
due = 2026-08-29
created_at = 2026-08-29T09:15:00Z
updated_at = 2026-08-29T09:15:00Z
+++
Confirm the fixture exposes every representative surface.
EOF

cat > "$destination/tasks/debug-vault/TSK-brisk-otter-3df6q.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000005"
title = "Prepare debug walkthrough"
type = "TASK"
project = "debug-vault"
status = "TRIAGE"
priority = "P1"
due = 2026-09-02
created_at = 2026-08-29T09:20:00Z
updated_at = 2026-08-29T09:20:00Z
+++
- [ ] Open the project
- [ ] Inspect linked notes
EOF

cat > "$destination/tasks/debug-vault/TSK-clear-raven-4gh7r.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000006"
title = "Exercise active work"
type = "TASK"
project = "debug-vault"
status = "FIELD"
priority = "P2"
cycle = "S-steady-finch-5jk8s"
due = 2026-08-28
hold = "Waiting for fixture review"
created_at = 2026-08-29T09:25:00Z
updated_at = 2026-08-29T09:25:00Z
+++
This task demonstrates an overdue, blocked item in an active cycle.
EOF

cat > "$destination/tasks/debug-vault/TSK-fresh-tiger-6mn9t.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000007"
title = "Review debug surfaces"
type = "TASK"
project = "debug-vault"
status = "REVIEW"
priority = "P3"
cycle = "S-steady-finch-5jk8s"
created_at = 2026-08-29T09:30:00Z
updated_at = 2026-08-29T09:30:00Z
+++
Check Board, Journal, Meetings, Bases, and Feeds.
EOF

cat > "$destination/tasks/debug-vault/TSK-grand-wren-7pq2v.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000008"
title = "Initialize debug vault"
type = "TASK"
project = "debug-vault"
status = "SEALED"
priority = "P2"
cycle = "S-steady-finch-5jk8s"
due = 2026-08-29
created_at = 2026-08-29T08:45:00Z
updated_at = 2026-08-29T09:00:00Z
+++
The deterministic fixture was initialized successfully.
EOF

cat > "$destination/cycles/S-steady-finch-5jk8s.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-000000000009"
title = "Debug Fixture Cycle"
type = "CYCLE"
state = "ACTIVE"
start = 2026-08-24
end = 2026-08-30
goal = "Exercise representative vault workflows"
created_at = 2026-08-24T09:00:00Z
updated_at = 2026-08-29T09:00:00Z
+++
A deterministic active cycle for the debug project.
EOF

cat > "$destination/journals/20260829.2026-08-29.DbgJrnl1.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-00000000000a"
title = "2026-08-29"
type = "JOURNAL"
tags = ["debug"]
created_at = 2026-08-29T08:00:00Z
updated_at = 2026-08-29T09:00:00Z
+++
# 2026-08-29

- [ ] Exercise the debug vault [priority:: A]
- [x] Seed deterministic fixture data
EOF

cat > "$destination/meetings/debug-vault/20260829.debug-standup.DbgMeet1.md" <<'EOF'
+++
id = "019f1a2b-0000-7000-8000-00000000000b"
title = "Debug Standup"
type = "MEETING"
project = "debug-vault"
attendees = ["[[Ada Lovelace]]", "[[Grace Hopper]]"]
occurred_at = 2026-08-29T10:00:00Z
tags = ["debug", "standup"]
created_at = 2026-08-29T10:00:00Z
updated_at = 2026-08-29T10:30:00Z
+++
## Agenda

- Verify representative data.

## Notes

The fixture is ready for local development.
EOF

cat > "$destination/bases/debug-notes.base.toml" <<'EOF'
name = "Debug Notes"
description = "Representative pages in the deterministic debug project."

[filter]
all = [ { field = "project", op = "eq", value = "debug-vault" } ]

[properties]
status = { type = "select", options = ["INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED"] }
priority = { type = "select", options = ["P0", "P1", "P2", "P3"] }
due = { type = "date" }

[[views]]
name = "Debug Project"
layout = "table"
sort = [ { field = "updated_at", dir = "desc" } ]
columns = ["title", "kind", "status", "priority", "updated_at"]
EOF

cat > "$destination/feeds.md" <<'EOF'
## Engineering #debug

- [Clepsydra Example](https://example.invalid/feed.xml) #fixture
EOF
