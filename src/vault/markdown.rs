//! Shared pulldown-cmark options for parsing vault markdown.

use pulldown_cmark::Options;

/// Parser options for vault and user-supplied markdown.
///
/// An explicit allowlist rather than `Options::all()`, so upstream releases
/// cannot silently switch extensions on. Deliberately excluded:
/// - `ENABLE_WIKILINKS`: Clepsydra parses its own `[[…]]` grammar from Text
///   events; pulldown's wikilinks would swallow them.
/// - `ENABLE_SUBSCRIPT` / `ENABLE_SUPERSCRIPT`: single-`~` subscript
///   collides with the vault's single-tilde strikethrough convention.
/// - `ENABLE_DEFINITION_LIST`: pulldown-cmark 0.12.2's first pass panics on
///   blockquote + `:` input (minimal repros `"\n>.\n>:"` and `">p\n>:\n\n"`).
///   Fixed upstream in 0.13.4; re-enabling is a follow-up commit that lands
///   separately from this dependency bump.
///
/// Every `Parser::new_ext` over vault content must use these options (or
/// `Options::empty()` where extensions are deliberately off, as in link
/// extraction and the rewriter).
pub fn markdown_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_SMART_PUNCTUATION
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS
        | Options::ENABLE_OLD_FOOTNOTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_are_the_curated_allowlist() {
        let opts = markdown_options();
        assert!(!opts.contains(Options::ENABLE_DEFINITION_LIST));
        assert!(opts.contains(Options::ENABLE_TABLES));
        assert!(opts.contains(Options::ENABLE_FOOTNOTES));
        assert!(opts.contains(Options::ENABLE_GFM));
        assert!(!opts.contains(Options::ENABLE_WIKILINKS));
        assert!(!opts.contains(Options::ENABLE_SUBSCRIPT));
        assert!(!opts.contains(Options::ENABLE_SUPERSCRIPT));
    }
}
