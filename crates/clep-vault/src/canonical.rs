use std::fmt;

use unicode_normalization::UnicodeNormalization;

/// A normalized, case-insensitive lookup key for pages.
///
/// Used for link resolution and alias matching. Never stored in frontmatter —
/// only in the in-memory index.
///
/// **Invariants:** lowercase, Unicode NFC, runs of whitespace collapsed to a
/// single space, trimmed. The `.md` extension is stripped when constructing
/// from a filename.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalName {
    inner: String,
}

impl CanonicalName {
    /// Core normalization algorithm.
    ///
    /// 1. Unicode NFC normalization
    /// 2. Unicode-aware lowercase
    /// 3. Collapse runs of whitespace to a single space
    /// 4. Trim leading/trailing whitespace
    /// 5. Strip `.md` extension if present
    pub fn new(input: &str) -> Self {
        // 1. NFC normalization
        let nfc: String = input.nfc().collect();

        // 2. Unicode-aware lowercase
        let lowered = nfc.to_lowercase();

        // 3. Collapse runs of whitespace to single space
        let mut collapsed = String::with_capacity(lowered.len());
        let mut prev_ws = false;
        for ch in lowered.chars() {
            if ch.is_whitespace() {
                if !prev_ws {
                    collapsed.push(' ');
                }
                prev_ws = true;
            } else {
                collapsed.push(ch);
                prev_ws = false;
            }
        }

        // 4. Trim leading/trailing whitespace
        let trimmed = collapsed.trim().to_string();

        // 5. Strip `.md` extension if present
        let result = trimmed
            .strip_suffix(".md")
            .map(String::from)
            .unwrap_or(trimmed);

        Self { inner: result }
    }

    /// Derive a canonical name from a frontmatter title.
    pub fn from_title(title: &str) -> Self {
        Self::new(title)
    }

    /// Derive a canonical name from a filename (stem is extracted before
    /// normalization only when the input contains `.md`; other processing
    /// is handled by `new`).
    pub fn from_filename(filename: &str) -> Self {
        Self::new(filename)
    }

    /// The normalized string.
    pub fn as_str(&self) -> &str {
        &self.inner
    }
}

impl fmt::Display for CanonicalName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_strips_md_extension() {
        let cn = CanonicalName::new("readme.md");
        assert_eq!(cn.as_str(), "readme");
    }

    #[test]
    fn display_impl() {
        let cn = CanonicalName::from_title("Hello World");
        assert_eq!(format!("{cn}"), "hello world");
    }
}
