import ClepsydraCore
import SwiftUI

public struct SearchResultRow: View {
    public let result: SearchResult

    public init(result: SearchResult) {
        self.result = result
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(displayTitle)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(1)

            Text(result.path)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            highlightedSnippet
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(displayTitle), \(result.path)")
    }

    private var displayTitle: String {
        guard let title = result.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
            return result.path
        }
        return title
    }

    private var highlightedSnippet: Text {
        var rendered = AttributedString()
        for segment in SearchSnippet.parse(result.snippet) {
            var attributedSegment = AttributedString(segment.text)
            if segment.highlighted {
                attributedSegment.foregroundColor = .accentColor
                attributedSegment.backgroundColor = .accentColor.opacity(0.15)
            }
            rendered.append(attributedSegment)
        }
        return Text(rendered)
    }
}
