import Foundation
import SwiftUI

public struct MarkdownPreview: View {
    public let markdown: String

    public init(markdown: String) {
        self.markdown = markdown
    }

    public var body: some View {
        Text(renderedMarkdown)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    public static func normalizedMarkdown(_ markdown: String) -> String {
        var normalized = markdown
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in
                let text = String(line)
                if text.hasPrefix("- [x] ") || text.hasPrefix("- [X] ") {
                    return "- ☑ " + text.dropFirst(6)
                }
                if text.hasPrefix("- [ ] ") {
                    return "- ☐ " + text.dropFirst(6)
                }
                return text
            }
            .joined(separator: "\n")

        normalized = removingUnsafeLinkDestinations(from: normalized)
        return normalized
    }

    private var renderedMarkdown: AttributedString {
        let normalized = Self.normalizedMarkdown(markdown)
        return (try? AttributedString(markdown: normalized)) ?? AttributedString(normalized)
    }

    private static func removingUnsafeLinkDestinations(from markdown: String) -> String {
        var result = markdown
        var searchStart = result.startIndex

        while let marker = result.range(
            of: "](",
            options: [],
            range: searchStart..<result.endIndex,
            locale: nil
        ) {
            let destinationStart = marker.upperBound
            guard let closing = result.firstIndex(of: ")", within: destinationStart..<result.endIndex) else {
                break
            }

            let destination = String(result[destinationStart..<closing])
                .split(whereSeparator: { $0.isWhitespace })
                .first
                .map(String.init) ?? ""
            if !isSafeExternalDestination(destination) {
                let destinationEnd = result.index(destinationStart, offsetBy: destination.count)
                result.replaceSubrange(destinationStart..<destinationEnd, with: "")
                searchStart = destinationStart
            } else {
                searchStart = closing
            }
        }

        return result
    }

    private static func isSafeExternalDestination(_ destination: String) -> Bool {
        guard let url = URL(string: destination),
              let scheme = url.scheme?.lowercased() else {
            return false
        }
        return scheme == "https"
    }
}

private extension String {
    func firstIndex(of character: Character, within range: Range<String.Index>) -> String.Index? {
        firstIndex(of: character, in: range)
    }

    func firstIndex(of character: Character, in range: Range<String.Index>) -> String.Index? {
        self[range].firstIndex(of: character)
    }
}
