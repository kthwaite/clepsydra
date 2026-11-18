//! Shared pulldown-cmark options for parsing vault markdown.

use pulldown_cmark::{Options, Parser};

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
///
/// Pass these through [`panic_safe_options`] before parsing vault or
/// user-supplied markdown.
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

/// Returns `options`, without `ENABLE_HEADING_ATTRIBUTES` when pulldown-cmark
/// panics on `markdown` with them.
///
/// pulldown-cmark 0.13.6 (the latest release) panics on some setext headings
/// when heading attributes are on: its attribute-block scan slices an
/// inverted range or truncates the heading into an invalid tree. Minimal
/// repros: `"- [ ] \\\n  ---"` (also needs task lists) and `">]\n>  {}\n>-"`.
/// The panic fires in `Parser::new_ext` or during iteration, depending on the
/// input and the build profile, so this runs one full trial parse and falls
/// back to the options that are panic-free on those inputs. An affected page
/// keeps all its content; only its `{#id .class}` heading blocks stay literal
/// text.
///
/// Every `Parser::new_ext` over vault or user content must take its options
/// from here. Drop the trial parse once upstream fixes the repros; the canary
/// tests below pin them.
pub fn panic_safe_options(markdown: &str, options: Options) -> Options {
    if !options.contains(Options::ENABLE_HEADING_ATTRIBUTES) {
        return options;
    }
    let parses = std::panic::catch_unwind(|| {
        Parser::new_ext(markdown, options)
            .into_offset_iter()
            .for_each(drop);
    })
    .is_ok();
    if parses {
        options
    } else {
        options - Options::ENABLE_HEADING_ATTRIBUTES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Blockquote + definition-marker inputs that crashed pulldown-cmark
    /// 0.12.2 (offset-iterator range inversion; first-pass spine underflow).
    /// Canaries: they must stay panic-free with definition lists enabled.
    const PANIC_REPRO_OFFSET: &str = "\n>.\n>:";
    const PANIC_REPRO_FIRSTPASS: &str = ">p\n>:\n\n";

    /// Setext-heading inputs that crash pulldown-cmark 0.13.6 with
    /// `ENABLE_HEADING_ATTRIBUTES` on (see `panic_safe_options`). The first
    /// also needs `ENABLE_TASKLISTS` and panics in `Parser::new_ext`
    /// (firstpass.rs:2086, slice index 6..5). The second panics in
    /// `Parser::new_ext` in debug builds (tree.rs:237) and during iteration
    /// in release builds (parse.rs:2327, "unexpected item body").
    const PANIC_REPRO_TASK_SETEXT: &str = "- [ ] \\\n  ---";
    const PANIC_REPRO_QUOTE_SETEXT_ATTRS: &str = ">]\n>  {}\n>-";

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

    #[test]
    fn task_item_backslash_before_setext_underline_is_panic_free() {
        let input = PANIC_REPRO_TASK_SETEXT;
        let options = panic_safe_options(input, markdown_options());
        assert_eq!(
            options,
            markdown_options() - Options::ENABLE_HEADING_ATTRIBUTES
        );
        let events = Parser::new_ext(input, options).into_offset_iter().count();
        assert!(events > 0);
    }

    #[test]
    fn blockquote_setext_heading_with_attribute_block_is_panic_free() {
        let input = PANIC_REPRO_QUOTE_SETEXT_ATTRS;
        let options = panic_safe_options(input, markdown_options());
        assert_eq!(
            options,
            markdown_options() - Options::ENABLE_HEADING_ATTRIBUTES
        );
        let events = Parser::new_ext(input, options).into_offset_iter().count();
        assert!(events > 0);
    }

    #[test]
    fn panic_safe_options_keeps_every_option_for_ordinary_markdown() {
        let input = "## Section {#anchor}\n\n- [ ] task\n\nTitle\n===\n";
        assert_eq!(
            panic_safe_options(input, markdown_options()),
            markdown_options()
        );
    }
}
