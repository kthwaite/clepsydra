//! Task and Cycle codes: `TSK-<adjective>-<noun>-<tail>` / `S-…`
//! (docs/adr/0003-hybrid-petname-task-codes.md). Two frozen 512-word lists
//! carry memorability; a 5-character lowercase Crockford base32 tail carries
//! the entropy (43 bits total). Codes are lowercase after the prefix because
//! they are filenames on a case-insensitive filesystem.

use std::sync::LazyLock;

use regex::Regex;

use super::block_id::fill_random_crockford32;
use super::kind::Kind;

pub const TAIL_LEN: usize = 5;
pub const CROCKFORD32: &[u8; 32] = super::block_id::CROCKFORD32;

static ADJECTIVES: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| include_str!("wordlists/adjectives.txt").lines().collect());
static NOUNS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| include_str!("wordlists/nouns.txt").lines().collect());
static CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(TSK|S)-[a-z]{3,6}-[a-z]{3,6}-[0-9a-hjkmnp-tv-z]{5}$").expect("static regex")
});

/// Which entity family a code names: `TSK-` for Tasks, `S-` for Cycles
/// (Cycles are "sprints" in the older vocabulary — hence `S`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeFamily {
    Task,
    Cycle,
}

impl CodeFamily {
    pub fn prefix(self) -> &'static str {
        match self {
            CodeFamily::Task => "TSK-",
            CodeFamily::Cycle => "S-",
        }
    }

    pub fn kind(self) -> Kind {
        match self {
            CodeFamily::Task => Kind::Task,
            CodeFamily::Cycle => Kind::Cycle,
        }
    }

    pub fn from_kind(kind: Kind) -> Option<Self> {
        match kind {
            Kind::Task => Some(CodeFamily::Task),
            Kind::Cycle => Some(CodeFamily::Cycle),
            _ => None,
        }
    }
}

/// The frozen 512-word adjective list, sorted ascending. Order and contents
/// are pinned by `word_lists_are_frozen_shape` — never edit after release.
pub fn adjectives() -> &'static [&'static str] {
    &ADJECTIVES
}

/// The frozen 512-word noun list, sorted ascending. Order and contents are
/// pinned by `word_lists_are_frozen_shape` — never edit after release.
pub fn nouns() -> &'static [&'static str] {
    &NOUNS
}

/// Mint a fresh code. Uniqueness against the vault is the caller's job
/// (re-roll on collision); this only guarantees the format.
pub fn mint(family: CodeFamily) -> String {
    let mut tail = [0u8; TAIL_LEN];
    fill_random_crockford32(&mut tail);
    let adj = ADJECTIVES[word_index() as usize];
    let noun = NOUNS[word_index() as usize];
    format!(
        "{}{}-{}-{}",
        family.prefix(),
        adj,
        noun,
        std::str::from_utf8(&tail).expect("crockford32 is ascii")
    )
}

/// One uniformly random index in `0..512`, drawn from the shared RNG via two
/// base32 draws (5 bits each = 10 bits, folded down to the 9 bits needed).
fn word_index() -> u16 {
    let mut b = [0u8; 2];
    fill_random_crockford32(&mut b);
    let hi = CROCKFORD32.iter().position(|c| *c == b[0]).unwrap_or(0) as u16;
    let lo = CROCKFORD32.iter().position(|c| *c == b[1]).unwrap_or(0) as u16;
    ((hi << 5) | lo) & 0x1ff
}

/// Whether `s` matches the full `TSK-adjective-noun-tail` / `S-…` format.
/// Rejects the legacy numeric format, uppercase, and malformed tails.
pub fn is_valid_code(s: &str) -> bool {
    CODE_RE.is_match(s)
}

/// The [`CodeFamily`] a valid code names, or `None` if `code` doesn't match
/// the format (see [`is_valid_code`]).
pub fn family_of(code: &str) -> Option<CodeFamily> {
    if !is_valid_code(code) {
        return None;
    }
    if code.starts_with("TSK-") {
        Some(CodeFamily::Task)
    } else {
        Some(CodeFamily::Cycle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn word_ok(w: &str) -> bool {
        (3..=6).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_lowercase())
    }

    #[test]
    fn word_lists_are_frozen_shape() {
        for list in [adjectives(), nouns()] {
            assert_eq!(list.len(), 512);
            assert!(
                list.iter().all(|w| word_ok(w)),
                "every word is 3-6 lowercase ascii letters"
            );
            assert!(
                list.windows(2).all(|p| p[0] < p[1]),
                "sorted ascending, unique"
            );
        }
        let adj: HashSet<&str> = adjectives().iter().copied().collect();
        assert!(
            nouns().iter().all(|n| !adj.contains(n)),
            "no word in both lists"
        );
    }

    #[test]
    fn mint_matches_format_and_family_prefix() {
        let t = mint(CodeFamily::Task);
        let c = mint(CodeFamily::Cycle);
        assert!(t.starts_with("TSK-") && is_valid_code(&t), "{t}");
        assert!(c.starts_with("S-") && is_valid_code(&c), "{c}");
        assert_eq!(family_of(&t), Some(CodeFamily::Task));
        assert_eq!(family_of(&c), Some(CodeFamily::Cycle));
        let tail = t.rsplit('-').next().unwrap();
        assert_eq!(tail.len(), TAIL_LEN);
        assert!(tail.bytes().all(|b| CROCKFORD32.contains(&b)));
        let body: Vec<&str> = t["TSK-".len()..].split('-').collect();
        assert!(adjectives().contains(&body[0]) && nouns().contains(&body[1]));
    }

    #[test]
    fn mints_are_distinct() {
        let set: HashSet<String> = (0..2000).map(|_| mint(CodeFamily::Task)).collect();
        assert_eq!(set.len(), 2000);
    }

    #[test]
    fn validation_rejects_legacy_uppercase_and_bad_tails() {
        for bad in [
            "TSK-0072",
            "S-3",
            "TSK-BRAVE-FINCH-7Q3ZD",
            "tsk-brave-finch-7q3zd",
            "TSK-brave-finch-7q3zi",
            "TSK-brave-finch-7q3z",
            "TSK-brave-7q3zd",
            "TSK-brave-finch-7q3zd-extra",
            "",
            "TSK-",
        ] {
            assert!(!is_valid_code(bad), "{bad}");
            assert_eq!(family_of(bad), None, "{bad}");
        }
        assert!(is_valid_code("TSK-brave-finch-7q3zd"));
        assert!(is_valid_code("S-calm-heron-2xm9p"));
    }

    #[test]
    fn family_kind_roundtrip() {
        use crate::vault::kind::Kind;
        assert_eq!(CodeFamily::Task.kind(), Kind::Task);
        assert_eq!(CodeFamily::from_kind(Kind::Cycle), Some(CodeFamily::Cycle));
        assert_eq!(CodeFamily::from_kind(Kind::Note), None);
    }
}
