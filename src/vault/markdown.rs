//! Shared pulldown-cmark options for parsing vault markdown.

use pulldown_cmark::Options;

/// Parser options for vault and user-supplied markdown.
///
/// `Options::all()` minus `ENABLE_DEFINITION_LIST`: pulldown-cmark 0.12.2
/// panics in its first pass on blockquote + definition-list input
/// (minimal repro: `"\n>.\n>:"`). The editor schema has no definition-list
/// element; the one consumer (search excerpts) only used the events to
/// strip `:` markers, a cosmetic behavior traded for panic safety. Every
/// `Parser::new_ext` over vault content must use these options (or
/// `Options::empty()` where extensions are deliberately off, as in link
/// extraction and the rewriter).
pub fn markdown_options() -> Options {
    let mut opts = Options::all();
    opts.remove(Options::ENABLE_DEFINITION_LIST);
    opts
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulldown_cmark::Parser;

    /// The exact input that panics pulldown-cmark 0.12.2's first pass when
    /// definition lists are enabled. Must not gain a trailing newline.
    const PANIC_REPRO: &str = "\n>.\n>:";

    #[test]
    fn options_exclude_definition_lists() {
        let opts = markdown_options();
        assert!(!opts.contains(Options::ENABLE_DEFINITION_LIST));
        // The rest of Options::all() stays on.
        assert!(opts.contains(Options::ENABLE_TABLES));
        assert!(opts.contains(Options::ENABLE_FOOTNOTES));
    }

    #[test]
    fn blockquote_definition_marker_parses_without_panic() {
        // A bare `Parser::new_ext(...).count()` does not reproduce the
        // panic; only the offset-tracking iteration path does (the one
        // `parse_blocks` and others actually use), so exercise that path.
        let events = Parser::new_ext(PANIC_REPRO, markdown_options())
            .into_offset_iter()
            .count();
        assert!(events > 0);
    }
}
