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
///
/// Definition lists are enabled: the pulldown-cmark 0.12 first-pass panics
/// on blockquote + `:` input (minimal repros `"\n>.\n>:"` and `">p\n>:\n\n"`)
/// are fixed in 0.13.4; the canary tests below keep us honest.
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
        | Options::ENABLE_DEFINITION_LIST
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulldown_cmark::Parser;

    /// Blockquote + definition-marker inputs that crashed pulldown-cmark
    /// 0.12.2 (offset-iterator range inversion; first-pass spine underflow).
    /// Canaries: they must stay panic-free with definition lists enabled.
    const PANIC_REPRO_OFFSET: &str = "\n>.\n>:";
    const PANIC_REPRO_FIRSTPASS: &str = ">p\n>:\n\n";

    #[test]
    fn options_are_the_curated_allowlist() {
        let opts = markdown_options();
        assert!(opts.contains(Options::ENABLE_DEFINITION_LIST));
        assert!(opts.contains(Options::ENABLE_TABLES));
        assert!(opts.contains(Options::ENABLE_FOOTNOTES));
        assert!(opts.contains(Options::ENABLE_GFM));
        assert!(!opts.contains(Options::ENABLE_WIKILINKS));
        assert!(!opts.contains(Options::ENABLE_SUBSCRIPT));
        assert!(!opts.contains(Options::ENABLE_SUPERSCRIPT));
    }

    #[test]
    fn blockquote_definition_marker_offset_iter_is_panic_free() {
        let events = Parser::new_ext(PANIC_REPRO_OFFSET, markdown_options())
            .into_offset_iter()
            .count();
        assert!(events > 0);
    }

    #[test]
    fn blockquote_definition_marker_firstpass_is_panic_free() {
        let events = Parser::new_ext(PANIC_REPRO_FIRSTPASS, markdown_options()).count();
        assert!(events > 0);
    }
}
