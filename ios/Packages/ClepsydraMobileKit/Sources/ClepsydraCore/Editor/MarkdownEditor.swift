import Foundation

/// A formatting action a Markdown editor can apply to the current selection.
public enum MarkdownEditingCommand: Hashable, Sendable, CaseIterable {
    case bold
    case italic
    case code
    case link
    /// Cycles the current line through `#`, `##`, `###`, then back to plain.
    case heading
    case bullet
    case quote
}

/// A text buffer and its selection after an edit.
public struct MarkdownEdit: Equatable, Sendable {
    public let text: String
    public let selectedRange: NSRange

    public init(text: String, selectedRange: NSRange) {
        self.text = text
        self.selectedRange = selectedRange
    }
}

/// Selection-aware Markdown editing, expressed as pure functions.
///
/// Ranges are UTF-16 offsets so the caller can hand `UITextView.selectedRange`
/// straight in and put the result straight back — keeping the platform view a
/// thin shell over logic that is testable on its own.
public enum MarkdownEditor {
    public static func applying(
        _ command: MarkdownEditingCommand,
        to text: String,
        selection: NSRange
    ) -> MarkdownEdit {
        switch command {
        case .bold: wrapping(text, selection, with: "**")
        case .italic: wrapping(text, selection, with: "*")
        case .code: wrapping(text, selection, with: "`")
        case .link: linking(text, selection)
        case .heading: cyclingHeading(text, selection)
        case .bullet: togglingPrefix(text, selection, prefix: "- ")
        case .quote: togglingPrefix(text, selection, prefix: "> ")
        }
    }

    /// The edit a newline should produce, or `nil` to insert a plain newline.
    ///
    /// Continuing the list is what makes a phone keyboard usable for notes: the
    /// alternative is retyping `- ` on every line. An empty item ends the list
    /// instead of adding another marker to an already-abandoned one.
    public static func continuingList(in text: String, at selection: NSRange) -> MarkdownEdit? {
        let source = text as NSString
        let lineRange = source.lineRange(for: NSRange(location: selection.location, length: 0))
        let line = source
            .substring(with: lineRange)
            .trimmingCharacters(in: .newlines)
        guard let item = listPrefix(of: line) else { return nil }

        if item.content.isEmpty {
            // Second return on an empty item: drop the marker rather than
            // stacking another one, which is how every list editor ends a list.
            let removal = NSRange(location: lineRange.location, length: (line as NSString).length)
            let updated = source.replacingCharacters(in: removal, with: "")
            return MarkdownEdit(
                text: updated,
                selectedRange: NSRange(location: lineRange.location, length: 0)
            )
        }

        let continuation = "\n" + item.nextMarker
        let updated = source.replacingCharacters(in: selection, with: continuation)
        return MarkdownEdit(
            text: updated,
            selectedRange: NSRange(
                location: selection.location + (continuation as NSString).length,
                length: 0
            )
        )
    }

    // MARK: - Inline commands

    private static func wrapping(_ text: String, _ selection: NSRange, with marker: String) -> MarkdownEdit {
        let source = text as NSString
        let markerLength = (marker as NSString).length
        let selected = source.substring(with: selection)

        // Already wrapped — a second tap removes the markers rather than
        // nesting them, so the button reads as a toggle.
        if selected.hasPrefix(marker), selected.hasSuffix(marker),
           (selected as NSString).length >= markerLength * 2 {
            let inner = String(selected.dropFirst(marker.count).dropLast(marker.count))
            return MarkdownEdit(
                text: source.replacingCharacters(in: selection, with: inner),
                selectedRange: NSRange(location: selection.location, length: (inner as NSString).length)
            )
        }

        let wrapped = marker + selected + marker
        let updated = source.replacingCharacters(in: selection, with: wrapped)
        return MarkdownEdit(
            text: updated,
            selectedRange: NSRange(
                location: selection.location + markerLength,
                length: (selected as NSString).length
            )
        )
    }

    private static func linking(_ text: String, _ selection: NSRange) -> MarkdownEdit {
        let source = text as NSString
        let selected = source.substring(with: selection)
        let inserted = "[\(selected)]()"
        let updated = source.replacingCharacters(in: selection, with: inserted)
        // Caret lands inside the parentheses: the destination is the part the
        // author still has to supply.
        let caret = selection.location + (inserted as NSString).length - 1
        return MarkdownEdit(text: updated, selectedRange: NSRange(location: caret, length: 0))
    }

    // MARK: - Line commands

    private static func cyclingHeading(_ text: String, _ selection: NSRange) -> MarkdownEdit {
        let source = text as NSString
        let lineRange = source.lineRange(for: selection)
        let line = source.substring(with: lineRange)
        let body = line.trimmingCharacters(in: .newlines)
        let terminator = String(line.dropFirst(body.count))

        let hashes = body.prefix(while: { $0 == "#" }).count
        let stripped = String(body.dropFirst(hashes)).drop(while: { $0 == " " })
        let next = hashes >= 3 ? 0 : hashes + 1
        let rebuilt = next == 0
            ? String(stripped)
            : String(repeating: "#", count: next) + " " + stripped

        return replacingLine(source, lineRange, with: rebuilt + terminator, selection: selection, previous: line)
    }

    private static func togglingPrefix(
        _ text: String,
        _ selection: NSRange,
        prefix: String
    ) -> MarkdownEdit {
        let source = text as NSString
        let lineRange = source.lineRange(for: selection)
        let line = source.substring(with: lineRange)
        let body = line.trimmingCharacters(in: .newlines)
        let terminator = String(line.dropFirst(body.count))

        let rebuilt = body.hasPrefix(prefix)
            ? String(body.dropFirst(prefix.count))
            : prefix + body

        return replacingLine(source, lineRange, with: rebuilt + terminator, selection: selection, previous: line)
    }

    /// Replaces one line and shifts the selection by however much it grew or shrank.
    private static func replacingLine(
        _ source: NSString,
        _ lineRange: NSRange,
        with replacement: String,
        selection: NSRange,
        previous: String
    ) -> MarkdownEdit {
        let delta = (replacement as NSString).length - (previous as NSString).length
        let updated = source.replacingCharacters(in: lineRange, with: replacement)
        let location = max(lineRange.location, selection.location + delta)
        return MarkdownEdit(
            text: updated,
            selectedRange: NSRange(location: location, length: selection.length)
        )
    }

    // MARK: - List parsing

    private struct ListPrefix {
        let nextMarker: String
        let content: String
    }

    private static func listPrefix(of line: String) -> ListPrefix? {
        let indent = String(line.prefix(while: { $0 == " " }))
        var rest = Substring(line).dropFirst(indent.count)

        if let lead = rest.first, lead == "-" || lead == "*" || lead == "+" {
            rest = rest.dropFirst()
            guard rest.first == " " else { return nil }
            rest = rest.dropFirst()
            // A task item continues as an *unchecked* task; carrying the tick
            // over would mark work done that has not been done.
            if rest.hasPrefix("[ ] ") || rest.hasPrefix("[x] ") || rest.hasPrefix("[X] ") {
                return ListPrefix(
                    nextMarker: "\(indent)\(lead) [ ] ",
                    content: String(rest.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                )
            }
            return ListPrefix(
                nextMarker: "\(indent)\(lead) ",
                content: String(rest).trimmingCharacters(in: .whitespaces)
            )
        }

        let digits = rest.prefix(while: \.isNumber)
        guard !digits.isEmpty, let number = Int(digits) else { return nil }
        rest = rest.dropFirst(digits.count)
        guard let punctuation = rest.first, punctuation == "." || punctuation == ")" else { return nil }
        rest = rest.dropFirst()
        guard rest.first == " " else { return nil }
        rest = rest.dropFirst()

        return ListPrefix(
            nextMarker: "\(indent)\(number + 1)\(punctuation) ",
            content: String(rest).trimmingCharacters(in: .whitespaces)
        )
    }
}
