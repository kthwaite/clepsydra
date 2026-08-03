import Foundation

/// One block-level element of a Markdown document.
///
/// The reader needs block structure as *data* rather than as attributes:
/// SwiftUI's `Text` ignores `presentationIntent`, so an `AttributedString`
/// parsed with `.full` collapses every block into one undifferentiated run with
/// no separator between them. Splitting first lets each block become its own
/// view with its own spacing and typography.
///
/// Inline syntax (emphasis, code spans, links) is deliberately *not* modelled
/// here — it stays as Markdown in each block's text and is handed to
/// `AttributedString` at render time, which handles inline runs correctly.
public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case quote([MarkdownBlock])
    case list(ordered: Bool, items: [MarkdownListItem])
    case code(language: String?, text: String)
    /// A table, kept verbatim for monospaced display. Rendering real columns is
    /// out of scope; preserving the author's alignment beats reflowing the
    /// pipes into prose.
    case table(String)
    case thematicBreak
}

public struct MarkdownListItem: Equatable, Sendable {
    public enum Marker: Equatable, Sendable {
        case bullet
        case ordered(Int)
        case task(done: Bool)
    }

    public let marker: Marker
    /// Nesting depth, in levels rather than columns.
    public let indent: Int
    public let text: String

    public init(marker: Marker, indent: Int = 0, text: String) {
        self.marker = marker
        self.indent = indent
        self.text = text
    }
}
