import Foundation

/// Splits Markdown source into block-level elements.
///
/// This is a deliberately partial CommonMark reader: it recognises the block
/// syntax that actually appears in vault notes and lets anything else fall
/// through to a paragraph, where inline parsing still applies. Getting block
/// *boundaries* right is what matters — everything inline is delegated to
/// `AttributedString` at render time.
public enum MarkdownDocument {
    public static func blocks(from markdown: String) -> [MarkdownBlock] {
        let normalized = markdown
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        return parse(normalized.components(separatedBy: "\n")[...])
    }

    // MARK: - Block scanning

    private static func parse(_ lines: ArraySlice<String>) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var index = lines.startIndex

        while index < lines.endIndex {
            let line = lines[index]

            if isBlank(line) {
                index += 1
            } else if let fence = fence(in: line) {
                blocks.append(codeBlock(lines, from: &index, fence: fence))
            } else if let heading = heading(in: line) {
                blocks.append(heading)
                index += 1
            } else if isThematicBreak(line) {
                blocks.append(.thematicBreak)
                index += 1
            } else if isQuote(line) {
                blocks.append(quote(lines, from: &index))
            } else if marker(in: line) != nil {
                blocks.append(list(lines, from: &index))
            } else if isTableStart(lines, at: index) {
                blocks.append(table(lines, from: &index))
            } else {
                blocks.append(paragraph(lines, from: &index))
            }
        }

        return blocks
    }

    private static func codeBlock(
        _ lines: ArraySlice<String>,
        from index: inout Int,
        fence: Fence
    ) -> MarkdownBlock {
        index += 1
        var body: [String] = []
        while index < lines.endIndex, !closes(lines[index], fence) {
            body.append(lines[index])
            index += 1
        }
        // An unterminated fence runs to the end of the document rather than
        // swallowing the rest as a paragraph.
        if index < lines.endIndex { index += 1 }
        return .code(language: fence.language, text: body.joined(separator: "\n"))
    }

    private static func quote(_ lines: ArraySlice<String>, from index: inout Int) -> MarkdownBlock {
        var inner: [String] = []
        while index < lines.endIndex, isQuote(lines[index]) || isLazyContinuation(lines, at: index) {
            inner.append(strippingQuoteMarker(lines[index]))
            index += 1
        }
        return .quote(parse(inner[...]))
    }

    private static func list(_ lines: ArraySlice<String>, from index: inout Int) -> MarkdownBlock {
        var items: [MarkdownListItem] = []
        var ordered = false

        while index < lines.endIndex {
            if let parsed = marker(in: lines[index]) {
                if items.isEmpty, case .ordered = parsed.marker { ordered = true }
                items.append(parsed)
                index += 1
            } else if !items.isEmpty, isIndentedContinuation(lines[index]) {
                // A wrapped item line rejoins its item rather than starting a
                // paragraph that would break the list in two.
                let last = items.removeLast()
                items.append(
                    MarkdownListItem(
                        marker: last.marker,
                        indent: last.indent,
                        text: last.text + " " + lines[index].trimmingCharacters(in: .whitespaces)
                    )
                )
                index += 1
            } else if isBlank(lines[index]), index + 1 < lines.endIndex, marker(in: lines[index + 1]) != nil {
                // Loose list: a blank line between items keeps one list.
                index += 1
            } else {
                break
            }
        }

        return .list(ordered: ordered, items: items)
    }

    private static func table(_ lines: ArraySlice<String>, from index: inout Int) -> MarkdownBlock {
        var rows: [String] = []
        while index < lines.endIndex, lines[index].contains("|"), !isBlank(lines[index]) {
            rows.append(lines[index])
            index += 1
        }
        return .table(rows.joined(separator: "\n"))
    }

    private static func paragraph(_ lines: ArraySlice<String>, from index: inout Int) -> MarkdownBlock {
        var body: [String] = []
        while index < lines.endIndex, !isBlank(lines[index]), !startsNewBlock(lines, at: index) {
            body.append(lines[index])
            index += 1
        }
        return .paragraph(body.joined(separator: "\n"))
    }

    /// True when the line at `index` opens a block other than a paragraph, and
    /// so must not be swallowed by the paragraph currently being collected.
    private static func startsNewBlock(_ lines: ArraySlice<String>, at index: Int) -> Bool {
        let line = lines[index]
        return fence(in: line) != nil
            || heading(in: line) != nil
            || isThematicBreak(line)
            || isQuote(line)
            || marker(in: line) != nil
            || isTableStart(lines, at: index)
    }

    // MARK: - Line classification

    private struct Fence {
        let character: Character
        let count: Int
        let language: String?
    }

    private static func isBlank(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static func fence(in line: String) -> Fence? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first, first == "`" || first == "~" else { return nil }
        let count = trimmed.prefix(while: { $0 == first }).count
        guard count >= 3 else { return nil }
        let info = trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces)
        return Fence(character: first, count: count, language: info.isEmpty ? nil : info)
    }

    private static func closes(_ line: String, _ fence: Fence) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.allSatisfy({ $0 == fence.character }) else { return false }
        return trimmed.count >= fence.count
    }

    private static func heading(in line: String) -> MarkdownBlock? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let rest = trimmed.dropFirst(hashes)
        // `#hashtag` is not a heading — CommonMark requires a space.
        guard rest.isEmpty || rest.first == " " else { return nil }
        // Closing hashes of a "### text ###" heading are decoration, not text.
        let text = rest.trimmingCharacters(in: .whitespaces).trimmingTrailingHashes()
        return .heading(level: hashes, text: text)
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        let stripped = line.filter { !$0.isWhitespace }
        guard stripped.count >= 3, let first = stripped.first else { return false }
        guard first == "-" || first == "*" || first == "_" else { return false }
        return stripped.allSatisfy { $0 == first }
    }

    private static func isQuote(_ line: String) -> Bool {
        let trimmed = line.drop(while: { $0 == " " })
        return trimmed.first == ">"
    }

    private static func strippingQuoteMarker(_ line: String) -> String {
        var rest = Substring(line).drop(while: { $0 == " " })
        guard rest.first == ">" else { return line }
        rest = rest.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    /// A quote continues across an unmarked line only when that line is plain
    /// prose — CommonMark's lazy continuation.
    private static func isLazyContinuation(_ lines: ArraySlice<String>, at index: Int) -> Bool {
        guard index > lines.startIndex else { return false }
        guard isQuote(lines[index - 1]) || !isBlank(lines[index - 1]) else { return false }
        return !isBlank(lines[index]) && !startsNewBlock(lines, at: index)
    }

    private static func isIndentedContinuation(_ line: String) -> Bool {
        line.hasPrefix("  ") && !isBlank(line)
    }

    private static func isTableStart(_ lines: ArraySlice<String>, at index: Int) -> Bool {
        guard lines[index].contains("|"), index + 1 < lines.endIndex else { return false }
        let delimiter = lines[index + 1].trimmingCharacters(in: .whitespaces)
        guard delimiter.contains("-"), delimiter.contains("|") else { return false }
        return delimiter.allSatisfy { $0 == "|" || $0 == "-" || $0 == ":" || $0 == " " }
    }

    private static func marker(in line: String) -> MarkdownListItem? {
        let leading = line.prefix(while: { $0 == " " }).count
        // Deep enough for four levels of nesting at the usual 2- or 4-space
        // step. Beyond that it is more likely stray indentation than a list.
        guard leading <= 8 else { return nil }
        let indent = min(leading / 2, 4)
        var rest = Substring(line).dropFirst(leading)

        if let lead = rest.first, lead == "-" || lead == "*" || lead == "+" {
            rest = rest.dropFirst()
            guard rest.first == " " else { return nil }
            rest = rest.drop(while: { $0 == " " })
            if let task = taskMarker(in: rest) {
                return MarkdownListItem(marker: .task(done: task.done), indent: indent, text: task.text)
            }
            return MarkdownListItem(marker: .bullet, indent: indent, text: String(rest))
        }

        let digits = rest.prefix(while: \.isNumber)
        guard !digits.isEmpty, digits.count <= 9 else { return nil }
        rest = rest.dropFirst(digits.count)
        guard let punctuation = rest.first, punctuation == "." || punctuation == ")" else { return nil }
        rest = rest.dropFirst()
        guard rest.first == " " else { return nil }
        rest = rest.drop(while: { $0 == " " })
        return MarkdownListItem(
            marker: .ordered(Int(digits) ?? 1),
            indent: indent,
            text: String(rest)
        )
    }

    private static func taskMarker(in rest: Substring) -> (done: Bool, text: String)? {
        guard rest.hasPrefix("["), rest.count >= 3 else { return nil }
        let state = rest[rest.index(rest.startIndex, offsetBy: 1)]
        let closing = rest.index(rest.startIndex, offsetBy: 2)
        guard rest[closing] == "]" else { return nil }
        guard state == " " || state == "x" || state == "X" else { return nil }
        let text = rest[rest.index(after: closing)...].drop(while: { $0 == " " })
        return (state != " ", String(text))
    }
}

private extension String {
    func trimmingTrailingHashes() -> String {
        var result = Substring(self)
        while result.last == "#" { result = result.dropLast() }
        return String(result).trimmingCharacters(in: .whitespaces)
    }
}
