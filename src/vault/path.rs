use std::fmt;

use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

/// Errors arising from invalid vault-relative paths.
#[derive(Debug, Error)]
pub enum PathError {
    #[error("empty path")]
    Empty,
    #[error("absolute path not allowed: {0}")]
    Absolute(String),
    #[error("path traversal not allowed: {0}")]
    Traversal(String),
    #[error("backslash not allowed (use forward slash): {0}")]
    Backslash(String),
    #[error("invalid path component: {0}")]
    InvalidComponent(String),
}

/// A vault-relative path, always forward-slash separated and NFC-normalized.
///
/// Invariants enforced at construction:
/// - No leading slash (not absolute)
/// - No backslashes
/// - No `..` components (no traversal)
/// - `.` and empty components are normalized away
/// - Non-empty after cleanup
/// - NFC-normalized Unicode
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VaultPath {
    inner: String,
}

impl VaultPath {
    /// Construct a `VaultPath` from a raw string, validating and normalizing.
    ///
    /// 1. Reject empty
    /// 2. Reject backslashes
    /// 3. Reject absolute paths (starts with `/`)
    /// 4. NFC normalize
    /// 5. Normalize `.` and duplicate `/` components
    /// 6. Reject `..` components
    /// 7. Reject if empty after cleanup
    pub fn new(raw: &str) -> Result<Self, PathError> {
        // 1. Reject empty
        if raw.is_empty() {
            return Err(PathError::Empty);
        }

        // 2. Reject backslashes
        if raw.contains('\\') {
            return Err(PathError::Backslash(raw.to_string()));
        }

        // 3. Reject absolute paths
        if raw.starts_with('/') {
            return Err(PathError::Absolute(raw.to_string()));
        }

        // 4. NFC normalize
        let normalized: String = raw.nfc().collect();

        // 5. Normalize away `.` and duplicate `/` components.
        let mut components: Vec<&str> = Vec::new();
        for component in normalized.split('/') {
            match component {
                "" | "." => continue,
                ".." => return Err(PathError::Traversal(raw.to_string())),
                _ => components.push(component),
            }
        }

        // 6/7. Reject if empty after cleanup
        if components.is_empty() {
            return Err(PathError::Empty);
        }

        Ok(Self {
            inner: components.join("/"),
        })
    }

    /// Generate a `VaultPath` from a human-readable title by slugifying it.
    ///
    /// The slug process:
    /// 1. NFC normalize
    /// 2. Percent-encode `%` -> `%25` (must come first)
    /// 3. Percent-encode `/` -> `%2F`
    /// 4. Replace illegal chars (`<>:"\|?*`, control chars) with `-`
    /// 5. Collapse runs of `-` to single `-`
    /// 6. Trim leading/trailing `-`
    /// 7. Truncate to 200 bytes (UTF-8 safe, don't split `%XX` sequences)
    /// 8. Append `.md`
    pub fn from_title(title: &str) -> Self {
        // 1. NFC normalize
        let normalized: String = title.nfc().collect();

        // 2. Percent-encode `%` -> `%25` (must come first)
        let encoded = normalized.replace('%', "%25");

        // 3. Percent-encode `/` -> `%2F`
        let encoded = encoded.replace('/', "%2F");

        // 4. Replace illegal chars with `-`
        let mut slug = String::with_capacity(encoded.len());
        for ch in encoded.chars() {
            if is_illegal_filename_char(ch) {
                slug.push('-');
            } else {
                slug.push(ch);
            }
        }

        // 5. Collapse runs of `-` to single `-`
        let mut collapsed = String::with_capacity(slug.len());
        let mut prev_dash = false;
        for ch in slug.chars() {
            if ch == '-' {
                if !prev_dash {
                    collapsed.push('-');
                }
                prev_dash = true;
            } else {
                collapsed.push(ch);
                prev_dash = false;
            }
        }

        // 6. Trim leading/trailing `-`
        let trimmed = collapsed.trim_matches('-');

        // 7. Truncate to 200 bytes (UTF-8 safe, don't split %XX sequences)
        let truncated = truncate_safe(trimmed, 200);

        // 8. Append `.md`
        let path = format!("{truncated}.md");

        Self { inner: path }
    }

    /// Decode the slug back to a human-readable title.
    ///
    /// Reverses percent-encoding on the stem (filename without `.md`):
    /// - `%2F` -> `/`
    /// - `%25` -> `%`
    pub fn decode_slug(&self) -> String {
        let stem = self.stem();
        // Decode `%2F` -> `/` first, then `%25` -> `%`
        let decoded = stem.replace("%2F", "/");
        decoded.replace("%25", "%")
    }

    /// The raw vault-relative path string.
    pub fn as_str(&self) -> &str {
        &self.inner
    }

    /// File extension without the dot, or `None` if there is none.
    pub fn extension(&self) -> Option<&str> {
        let filename = self.filename();
        // Find the last dot in the filename (not in directory components)
        if let Some(dot_pos) = filename.rfind('.')
            && dot_pos > 0
            && dot_pos < filename.len() - 1
        {
            return Some(&filename[dot_pos + 1..]);
        }
        None
    }

    /// Filename without extension (the stem of the final path component).
    pub fn stem(&self) -> &str {
        let filename = self.filename();
        if let Some(dot_pos) = filename.rfind('.')
            && dot_pos > 0
        {
            return &filename[..dot_pos];
        }
        filename
    }

    /// Parent directory, or `None` if the path is a root-level file.
    pub fn parent(&self) -> Option<&str> {
        if let Some(slash_pos) = self.inner.rfind('/') {
            Some(&self.inner[..slash_pos])
        } else {
            None
        }
    }

    /// The final path component (filename with extension).
    pub fn filename(&self) -> &str {
        if let Some(slash_pos) = self.inner.rfind('/') {
            &self.inner[slash_pos + 1..]
        } else {
            &self.inner
        }
    }
}

impl fmt::Display for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.inner)
    }
}

/// Returns `true` if the character is illegal in filenames.
/// Illegal chars: `<>:"\|?*` and control characters (U+0000..U+001F).
fn is_illegal_filename_char(ch: char) -> bool {
    matches!(ch, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*') || ch.is_control()
}

/// Truncate a string to at most `max_bytes` bytes, respecting:
/// - UTF-8 character boundaries
/// - Percent-encoded sequences (`%XX`) — never split mid-sequence
fn truncate_safe(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }

    // Start from the max_bytes boundary and work backwards to find a safe cut point.
    let mut end = max_bytes;

    // First, ensure we're on a UTF-8 character boundary.
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }

    // Now check if we're splitting a percent-encoded sequence.
    // A `%XX` sequence is 3 bytes. If the byte at `end-1` is `%`, we'd split
    // between `%` and `XX`. If the byte at `end-2` is `%`, we'd split between
    // `%X` and `X`. In either case, back up.
    let bytes = s.as_bytes();
    if end >= 1 && bytes[end - 1] == b'%' {
        // `%` is the last byte — back up past it
        end -= 1;
    } else if end >= 2 && bytes[end - 2] == b'%' {
        // `%X` are the last two bytes — back up past `%`
        end -= 2;
    }

    &s[..end]
}

/// Lowercased, hyphen-joined, length-capped slug for the human-readable middle
/// segment of a page filename. ASCII-folds spaces and punctuation to `-`,
/// collapses runs, trims, and truncates to at most `max_len` characters on a `-`
/// boundary. Empty/punctuation-only input yields `"untitled"`.
pub fn slugify_title(title: &str, max_len: usize) -> String {
    let lower = title.nfc().collect::<String>().to_lowercase();
    let mut slug = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    let out: String = trimmed.chars().take(max_len).collect();
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out.to_string()
    }
}

/// True if `name` already matches the canonical page filename shape
/// `<yyyymmdd>.<slug>.<8 base62>.md`. Used to make relabel idempotent.
pub fn is_canonical_page_filename(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    let parts: Vec<&str> = stem.split('.').collect();
    if parts.len() < 3 {
        return false;
    }
    let date = parts[0];
    let token = parts[parts.len() - 1];
    let date_ok = date.len() == 8 && date.chars().all(|c| c.is_ascii_digit());
    let token_ok = token.len() == 8 && token.chars().all(|c| c.is_ascii_alphanumeric());
    date_ok && token_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_safe_preserves_percent_encoding() {
        // "%25" is 3 bytes; if max_bytes would cut into it, we back up.
        let s = "abc%25def";
        // max_bytes = 5 would cut between `%` and `25`, so we expect "abc"
        assert_eq!(truncate_safe(s, 5), "abc");
        // max_bytes = 6 keeps "abc%25"
        assert_eq!(truncate_safe(s, 6), "abc%25");
    }

    #[test]
    fn slugify_lowercases_hyphenates_and_truncates() {
        assert_eq!(slugify_title("Redesign Retro!", 40), "redesign-retro");
        assert_eq!(
            slugify_title("  Multiple   Spaces  ", 40),
            "multiple-spaces"
        );
        // truncation does not leave a trailing dash
        assert_eq!(slugify_title("abcdefghij", 5), "abcde");
        assert_eq!(slugify_title("ab cd ef", 5), "ab-cd");
        // empty / punctuation-only title -> stable fallback
        assert_eq!(slugify_title("", 40), "untitled");
        assert_eq!(slugify_title("!!!", 40), "untitled");
    }

    #[test]
    fn stem_strips_only_trailing_md_for_dotted_filenames() {
        let vp = VaultPath::new("notes/20260531.redesign-retro.3kF9a2bQ.md").unwrap();
        assert_eq!(vp.stem(), "20260531.redesign-retro.3kF9a2bQ");
        assert_eq!(vp.filename(), "20260531.redesign-retro.3kF9a2bQ.md");
    }

    #[test]
    fn detects_canonical_page_filename() {
        assert!(is_canonical_page_filename(
            "20260531.redesign-retro.3kF9a2bQ.md"
        ));
        assert!(is_canonical_page_filename("20260531.a.0000aaaa.md"));
        // old-style names are not canonical
        assert!(!is_canonical_page_filename("My Note.md"));
        assert!(!is_canonical_page_filename("2026-wang.pdf"));
        // wrong token length / missing parts
        assert!(!is_canonical_page_filename("20260531.x.short.md"));
    }
}
