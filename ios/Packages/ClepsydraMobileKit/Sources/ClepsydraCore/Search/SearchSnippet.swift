import Foundation

public struct SearchSnippet: Equatable, Sendable {
    public let text: String
    public let highlighted: Bool

    public init(text: String, highlighted: Bool) {
        self.text = text
        self.highlighted = highlighted
    }

    public static func parse(_ snippet: String) -> [SearchSnippet] {
        let opening = "<mark>"
        let closing = "</mark>"
        var segments: [SearchSnippet] = []
        var remaining = snippet

        while let openingRange = remaining.range(of: opening) {
            let before = String(remaining[..<openingRange.lowerBound])
            let markedStart = openingRange.upperBound
            guard let closingRange = remaining.range(of: closing, range: markedStart..<remaining.endIndex) else {
                append(before + String(remaining[openingRange.lowerBound...]), highlighted: false, to: &segments)
                return segments
            }

            append(before, highlighted: false, to: &segments)
            append(String(remaining[markedStart..<closingRange.lowerBound]), highlighted: true, to: &segments)
            remaining = String(remaining[closingRange.upperBound...])
        }

        append(remaining, highlighted: false, to: &segments)
        return segments
    }

    private static func append(_ text: String, highlighted: Bool, to segments: inout [SearchSnippet]) {
        guard !text.isEmpty else { return }
        segments.append(SearchSnippet(text: text, highlighted: highlighted))
    }
}
