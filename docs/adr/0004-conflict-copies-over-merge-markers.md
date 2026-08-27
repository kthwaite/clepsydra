# Conflict Copies instead of merge markers in the working tree

When `clep sync` merges divergent device histories, the same page may have been edited on
both sides. Leaving standard git conflict markers in the tree makes the vault present
broken content as page bodies, and the indexer's frontmatter repair is destructive for
add/add conflicts (verified empirically: markers before the opening `+++` fence cause
repair to prepend fresh frontmatter with a third UUID and demote both versions into the
body). We decided sync never leaves a conflicted working tree: a structural frontmatter
merge driver resolves what it can (max `updated_at`, tag union), and a genuine content
conflict resolves to "ours" while "theirs" is written beside it as a Conflict Copy —
`<stem>.conflict.<shortid>.md`, fresh page id, `conflict_of = "<original path>"` — for
manual reconciliation later, surfaced by a doctor rule and the UI conflicts list.

## Consequences

- Encrypted (age) bodies, unmergeable by design, are handled by the same mechanism with no special case.
- Independently of sync, the indexer treats any file containing the three conflict-marker
  lines as conflicted: it indexes read-only, never repairs, and emits a diagnostic —
  protection for hand-run `git pull`.
- Resolution is ordinary editing: merge by hand, delete the copy.
