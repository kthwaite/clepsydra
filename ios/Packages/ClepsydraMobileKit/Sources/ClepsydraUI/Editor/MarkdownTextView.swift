import ClepsydraCore
import SwiftUI

#if canImport(UIKit)
import UIKit

/// Applies formatting commands to whichever text view is currently on screen.
///
/// A toolbar button has to act on the *selection*, which SwiftUI's `TextEditor`
/// does not expose on this deployment target. The controller is the seam: the
/// view registers itself, the toolbar sends commands, and all the actual
/// editing logic stays in `MarkdownEditor` where it can be tested.
@MainActor
public final class MarkdownEditingController {
    fileprivate weak var textView: UITextView?

    public init() {}

    public func apply(_ command: MarkdownEditingCommand) {
        guard let textView else { return }
        let edit = MarkdownEditor.applying(
            command,
            to: textView.text ?? "",
            selection: textView.selectedRange
        )
        textView.text = edit.text
        textView.selectedRange = edit.selectedRange
        // Programmatic mutation does not call the delegate, so the binding
        // would otherwise keep the pre-command text and the edit would be lost
        // on save.
        textView.delegate?.textViewDidChange?(textView)
    }

    public func endEditing() {
        textView?.resignFirstResponder()
    }
}

public struct MarkdownTextView: UIViewRepresentable {
    @Binding private var text: String
    private let controller: MarkdownEditingController

    public init(text: Binding<String>, controller: MarkdownEditingController) {
        _text = text
        self.controller = controller
    }

    public func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = .monospacedSystemFont(
            ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize,
            weight: .regular
        )
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)
        view.autocapitalizationType = .sentences
        // Smart punctuation rewrites the characters Markdown is made of:
        // `--` becomes an en dash and `"` becomes a curly quote, neither of
        // which round-trips through the vault as the author typed it.
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.text = text
        controller.textView = view
        return view
    }

    public func updateUIView(_ view: UITextView, context: Context) {
        controller.textView = view
        guard view.text != text else { return }
        let selection = view.selectedRange
        view.text = text
        // The new text may be shorter than the old selection — reloading a
        // server version, for instance — so the caret is clamped rather than
        // restored blindly.
        let limit = (view.text as NSString).length
        view.selectedRange = NSRange(location: min(selection.location, limit), length: 0)
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    public final class Coordinator: NSObject, UITextViewDelegate {
        private let text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        public func textViewDidChange(_ textView: UITextView) {
            text.wrappedValue = textView.text
        }

        public func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText replacement: String
        ) -> Bool {
            guard replacement == "\n" else { return true }
            guard let edit = MarkdownEditor.continuingList(in: textView.text, at: range) else {
                return true
            }
            textView.text = edit.text
            textView.selectedRange = edit.selectedRange
            text.wrappedValue = edit.text
            return false
        }
    }
}

#else

/// AppKit fallback. The package builds for macOS so its logic can be tested
/// there; the phone is the only place this editor actually ships.
public final class MarkdownEditingController {
    public init() {}
    public func apply(_ command: MarkdownEditingCommand) {}
    public func endEditing() {}
}

public struct MarkdownTextView: View {
    @Binding private var text: String

    public init(text: Binding<String>, controller: MarkdownEditingController) {
        _text = text
    }

    public var body: some View {
        TextEditor(text: $text)
            .font(.system(.body, design: .monospaced))
    }
}

#endif

extension MarkdownEditingCommand {
    /// SF Symbol for the toolbar button.
    var symbolName: String {
        switch self {
        case .bold: "bold"
        case .italic: "italic"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .link: "link"
        case .heading: "number"
        case .bullet: "list.bullet"
        case .quote: "text.quote"
        }
    }

    var accessibilityName: String {
        switch self {
        case .bold: "Bold"
        case .italic: "Italic"
        case .code: "Code"
        case .link: "Link"
        case .heading: "Heading"
        case .bullet: "Bullet list"
        case .quote: "Quote"
        }
    }
}
