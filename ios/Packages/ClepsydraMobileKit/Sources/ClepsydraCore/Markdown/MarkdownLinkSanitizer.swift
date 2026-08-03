import Foundation

/// Removes link destinations the reader must not make tappable.
///
/// The reader displays Markdown authored elsewhere, so a destination is treated
/// as hostile until proven otherwise: only `https` survives. Everything else —
/// `javascript:`, `data:`, `file:`, plain `http:` — has its destination emptied,
/// which leaves the link text visible but inert.
public enum MarkdownLinkSanitizer {
    public static func sanitizingDestinations(in markdown: String) -> String {
        var result = markdown
        var searchStart = result.startIndex

        while let marker = result.range(of: "](", range: searchStart..<result.endIndex) {
            let destinationStart = marker.upperBound
            guard let closing = closingParenthesis(in: result, from: destinationStart) else { break }

            let raw = String(result[destinationStart..<closing])
                .split(whereSeparator: \.isWhitespace)
                .first
                .map(String.init) ?? ""
            let destinationEnd = result.index(destinationStart, offsetBy: raw.count)

            if let safe = safeDestination(raw) {
                // Rewritten rather than left alone: an angle-bracketed
                // destination is valid CommonMark but `AttributedString` will
                // not parse it, so unwrapping here is what makes the link work.
                result.replaceSubrange(destinationStart..<destinationEnd, with: safe)
                searchStart = result.index(destinationStart, offsetBy: safe.count)
            } else {
                result.replaceSubrange(destinationStart..<destinationEnd, with: "")
                searchStart = destinationStart
            }
        }

        return result
    }

    /// Index of the `)` that closes the link, honouring nesting.
    ///
    /// Stopping at the first `)` would cut `javascript:alert(1)` in half and
    /// leave a stray bracket behind — and would truncate legitimate
    /// destinations like `https://en.wikipedia.org/wiki/Foo_(bar)`.
    private static func closingParenthesis(in text: String, from start: String.Index) -> String.Index? {
        var depth = 1
        var index = start
        var escaped = false

        while index < text.endIndex {
            let character = text[index]
            if escaped {
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "(" {
                depth += 1
            } else if character == ")" {
                depth -= 1
                if depth == 0 { return index }
            }
            index = text.index(after: index)
        }

        return nil
    }

    /// The destination to emit, or `nil` when it must be dropped.
    private static func safeDestination(_ raw: String) -> String? {
        var candidate = raw
        if candidate.hasPrefix("<"), candidate.hasSuffix(">"), candidate.count >= 2 {
            candidate = String(candidate.dropFirst().dropLast())
        }
        guard let url = URL(string: candidate),
              url.scheme?.lowercased() == "https" else {
            return nil
        }
        return candidate
    }
}
