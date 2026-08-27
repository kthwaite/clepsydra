# Hybrid petname codes for Tasks and Cycles

`clep sync` makes a vault multi-device. Sequential codes (`TSK-0072`) were minted from a
per-machine counter in the derived `.clepsydra/cache.db`, so two devices minting while
diverged produce the same code — and codes are filenames and addressing keys, so a
post-merge repair that renumbers them would break every reference. We decided codes are
minted as `TSK-<adjective>-<noun>-<tail>` (Cycles: `S-…`), e.g. `TSK-brave-finch-7q3zd`:
two words drawn from frozen, vendored 512-word lists plus a five-character lowercase
Crockford base32 tail — 43 bits, ~8.8×10¹² combinations, birthday-safe past a million
codes. The words carry memorability; the tail carries the entropy, so the lists can stay
small and curated. Everything is lowercase ASCII because APFS is case-insensitive and
codes are filenames.

## Considered Options

- Sequential + re-seed + post-merge repair: rejected — a code that can change is not an identifier.
- Pure random short-id (`TSK-x7kp2qm9`): collision-safe but unspeakable.
- Three-word petname: speakable, but the lists alone must carry all entropy.
- UUID: not human-addressable.

## Consequences

- Addressing accepts any unique code prefix (`TSK-brave-finch`), like git short SHAs; the full code is canonical.
- One-time migration renames every existing sequential-coded Task/Cycle file and rewrites
  all textual `TSK-\d{4}` / `S-\d+` mentions across the vault. Clean break: no legacy alias map.
- The word lists may grow but never shrink or reorder.
