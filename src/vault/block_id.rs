use std::cell::Cell;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// Base62 alphabet, ordered so that lexicographic string comparison
/// matches numeric ordering: `0-9 A-Z a-z`.
const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Number of base62 characters for the timestamp component.
const TIMESTAMP_CHARS: usize = 7;

/// Number of base62 characters for the random suffix.
const RANDOM_CHARS: usize = 4;

/// Total length of a generated block ID.
const BLOCK_ID_LEN: usize = TIMESTAMP_CHARS + RANDOM_CHARS;

/// A compact, time-sorted, base62 block identifier.
///
/// Format: 7 chars timestamp (milliseconds since Unix epoch, base62-encoded,
/// big-endian) followed by 4 chars of random base62 suffix — 11 characters
/// total.
///
/// Lexicographic ordering of block IDs corresponds to chronological ordering,
/// making them suitable for time-sorted block-level identity in markdown
/// documents (e.g. `^abc123DEF0` suffixes).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockId {
    inner: String,
}

impl BlockId {
    /// Generate a new block ID using the current system time and random suffix.
    pub fn generate() -> Self {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_millis() as u64;

        let mut buf = [0u8; BLOCK_ID_LEN];

        // Encode timestamp as big-endian base62, zero-padded to TIMESTAMP_CHARS.
        encode_base62(ms, &mut buf[..TIMESTAMP_CHARS]);

        // Fill random suffix with base62 characters.
        fill_random_base62(&mut buf[TIMESTAMP_CHARS..]);

        let s = std::str::from_utf8(&buf).expect("base62 is always valid UTF-8");
        Self {
            inner: s.to_owned(),
        }
    }

    /// Parse a string as a block ID, returning `None` if it is not valid.
    ///
    /// A valid block ID is 10-12 ASCII alphanumeric characters.
    pub fn parse(s: &str) -> Option<Self> {
        let len = s.len();
        if !(10..=12).contains(&len) {
            return None;
        }
        if !s.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        Some(Self {
            inner: s.to_owned(),
        })
    }

    /// Return the block ID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.inner
    }
}

impl fmt::Display for BlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.inner)
    }
}

/// Encode `value` into `buf` as big-endian base62, zero-padded.
fn encode_base62(mut value: u64, buf: &mut [u8]) {
    for slot in buf.iter_mut().rev() {
        *slot = BASE62[(value % 62) as usize];
        value /= 62;
    }
}

thread_local! {
    /// Per-thread xorshift state. Seeded lazily from the clock + stack entropy
    /// on first use, then *advanced* on every draw and carried across calls.
    /// Carrying the state is what guarantees that two rapid consecutive draws
    /// differ — a fresh per-call clock seed can repeat within a nanosecond
    /// window (identical time and identical stack address), which previously
    /// made `generate_short_id` collision-prone.
    static RNG_STATE: Cell<u64> = const { Cell::new(0) };
}

/// Draw the next xorshift64 value from the persistent per-thread stream.
fn next_random() -> u64 {
    RNG_STATE.with(|cell| {
        let mut state = cell.get();
        if state == 0 {
            state = random_seed();
        }
        state = xorshift64(state);
        cell.set(state);
        state
    })
}

/// Fill `buf` with random base62 characters drawn from the persistent
/// per-thread xorshift64 stream (see [`next_random`]).
fn fill_random_base62(buf: &mut [u8]) {
    for slot in buf.iter_mut() {
        *slot = BASE62[(next_random() % 62) as usize];
    }
}

/// Produce a non-zero seed by mixing nanosecond time with a stack address.
fn random_seed() -> u64 {
    let time_part = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos() as u64;

    // Mix in a pointer value for additional entropy across rapid calls.
    let stack_var: u8 = 0;
    let addr_part = std::ptr::addr_of!(stack_var) as u64;

    let seed = time_part ^ addr_part;
    // xorshift64 requires a non-zero state.
    if seed == 0 { 1 } else { seed }
}

/// A standalone 8-character random base62 token, for globally-unique page
/// filenames (see docs/adr/0002-page-filename-identity.md). Not time-sorted —
/// the filename's `yyyymmdd` prefix carries ordering.
pub fn generate_short_id() -> String {
    let mut buf = [0u8; 8];
    fill_random_base62(&mut buf);
    String::from_utf8(buf.to_vec()).expect("base62 is always valid UTF-8")
}

/// Lowercase Crockford base32 alphabet (no `i l o u`), used for the tail of
/// Task/Cycle codes (docs/adr/0003). Kept here so the RNG stays private.
pub(crate) const CROCKFORD32: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Fill `buf` with random lowercase Crockford base32 characters.
pub(crate) fn fill_random_crockford32(buf: &mut [u8]) {
    for slot in buf.iter_mut() {
        *slot = CROCKFORD32[(next_random() % 32) as usize];
    }
}

/// xorshift64 PRNG — fast, good enough for non-cryptographic random IDs.
fn xorshift64(mut state: u64) -> u64 {
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_id_is_eight_base62_chars() {
        let id = generate_short_id();
        assert_eq!(id.len(), 8);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn short_ids_vary() {
        // The persistent per-thread stream guarantees consecutive draws differ
        // (no reliance on clock resolution). Draw many and require all unique.
        use std::collections::HashSet;
        let ids: HashSet<String> = (0..1000).map(|_| generate_short_id()).collect();
        assert_eq!(ids.len(), 1000, "expected all short ids to be distinct");
    }
}
