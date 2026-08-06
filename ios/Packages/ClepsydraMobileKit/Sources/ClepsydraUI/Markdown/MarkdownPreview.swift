import ClepsydraCore
import Foundation
import SwiftUI

/// Renders Markdown as a stack of block views.
///
/// One `Text` over one `AttributedString` cannot work here: SwiftUI ignores the
/// `presentationIntent` that block-level parsing produces, so paragraphs,
/// headings and quotes all arrive concatenated with no separator. Blocks are
/// therefore laid out individually, and `AttributedString` is used only for
/// inline runs — emphasis, code spans and links — which it does handle.
public struct MarkdownPreview: View {
    private let blocks: [MarkdownBlock]

    public init(markdown: String) {
        blocks = MarkdownDocument.blocks(from: markdown)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(blocks.indices, id: \.self) { index in
                MarkdownBlockView(block: blocks[index])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case let .heading(level, text):
            Text(MarkdownInline.attributed(text))
                .font(Self.headingFont(for: level))
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity, alignment: .leading)

        case let .paragraph(text):
            Text(MarkdownInline.attributed(text))
                .frame(maxWidth: .infinity, alignment: .leading)

        case let .quote(inner):
            HStack(alignment: .top, spacing: 10) {
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(inner.indices, id: \.self) { index in
                        MarkdownBlockView(block: inner[index])
                    }
                }
                .italic()
                .padding(.vertical, 8)
                .padding(.trailing, 10)
            }
            .background(Color.secondary.opacity(0.1))
            .frame(maxWidth: .infinity, alignment: .leading)

        case let .list(ordered, items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.indices, id: \.self) { index in
                    MarkdownListRow(item: items[index], ordered: ordered)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        case let .code(language, text):
            VStack(alignment: .leading, spacing: 4) {
                if let language {
                    Text(language)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                // Code must not reflow, so it scrolls sideways instead of
                // wrapping at arbitrary points.
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12))

        case let .table(text):
            // Columns only line up in a monospaced font, and only if the rows
            // keep their original width.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12))

        case .thematicBreak:
            Divider()
        }
    }

    private static func headingFont(for level: Int) -> Font {
        switch level {
        case 1: .title
        case 2: .title2
        case 3: .title3
        case 4: .headline
        default: .subheadline
        }
    }
}

struct MarkdownListRow: View {
    let item: MarkdownListItem
    let ordered: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            marker
            Text(MarkdownInline.attributed(item.text))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, CGFloat(item.indent) * 16)
    }

    @ViewBuilder
    private var marker: some View {
        switch item.marker {
        case .bullet:
            Text("•").foregroundStyle(.secondary)
        case let .ordered(number):
            Text("\(number).")
                .foregroundStyle(.secondary)
                .monospacedDigit()
        case let .task(done):
            Image(systemName: done ? "checkmark.square.fill" : "square")
                .foregroundStyle(done ? Color.accentColor : Color.secondary)
                .accessibilityLabel(done ? "Completed" : "Not completed")
        }
    }
}

enum MarkdownInline {
    /// Inline-only parsing: block syntax has already been consumed by
    /// `MarkdownDocument`, and re-running it here would reintroduce the
    /// flattening this renderer exists to avoid.
    static func attributed(_ markdown: String) -> AttributedString {
        let sanitized = MarkdownLinkSanitizer.sanitizingDestinations(in: markdown)
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnly)
        return (try? AttributedString(markdown: sanitized, options: options))
            ?? AttributedString(sanitized)
    }
}
