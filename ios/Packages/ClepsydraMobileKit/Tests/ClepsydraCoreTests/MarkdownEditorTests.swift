import ClepsydraCore
import Foundation
import XCTest

final class MarkdownEditorTests: XCTestCase {
    // MARK: - Inline wrapping

    func testBoldWrapsTheSelectionAndKeepsItSelected() {
        let edit = MarkdownEditor.applying(.bold, to: "make this bold", selection: NSRange(location: 5, length: 4))

        XCTAssertEqual(edit.text, "make **this** bold")
        XCTAssertEqual(edit.selectedRange, NSRange(location: 7, length: 4))
    }

    func testBoldOnAnEmptySelectionLeavesTheCaretBetweenTheMarkers() {
        let edit = MarkdownEditor.applying(.bold, to: "ab", selection: NSRange(location: 1, length: 0))

        XCTAssertEqual(edit.text, "a****b")
        XCTAssertEqual(edit.selectedRange, NSRange(location: 3, length: 0))
    }

    func testASecondBoldUnwrapsRatherThanNesting() {
        let edit = MarkdownEditor.applying(.bold, to: "**this**", selection: NSRange(location: 0, length: 8))

        XCTAssertEqual(edit.text, "this")
        XCTAssertEqual(edit.selectedRange, NSRange(location: 0, length: 4))
    }

    func testItalicAndCodeUseTheirOwnMarkers() {
        XCTAssertEqual(
            MarkdownEditor.applying(.italic, to: "word", selection: NSRange(location: 0, length: 4)).text,
            "*word*"
        )
        XCTAssertEqual(
            MarkdownEditor.applying(.code, to: "word", selection: NSRange(location: 0, length: 4)).text,
            "`word`"
        )
    }

    func testLinkKeepsTheSelectionAsTextAndParksTheCaretInTheDestination() {
        let edit = MarkdownEditor.applying(.link, to: "see docs", selection: NSRange(location: 4, length: 4))

        XCTAssertEqual(edit.text, "see [docs]()")
        XCTAssertEqual(edit.selectedRange, NSRange(location: 11, length: 0))
    }

    // MARK: - Line prefixes

    func testHeadingCyclesThroughThreeLevelsAndBackToPlain() {
        var text = "Title"
        var selection = NSRange(location: 0, length: 0)
        var seen: [String] = []

        for _ in 0..<4 {
            let edit = MarkdownEditor.applying(.heading, to: text, selection: selection)
            text = edit.text
            selection = edit.selectedRange
            seen.append(text)
        }

        XCTAssertEqual(seen, ["# Title", "## Title", "### Title", "Title"])
    }

    func testBulletAndQuoteTogglePrefixesOnTheCurrentLine() {
        let bulleted = MarkdownEditor.applying(.bullet, to: "item", selection: NSRange(location: 0, length: 0))
        XCTAssertEqual(bulleted.text, "- item")

        let unbulleted = MarkdownEditor.applying(
            .bullet,
            to: bulleted.text,
            selection: bulleted.selectedRange
        )
        XCTAssertEqual(unbulleted.text, "item")

        XCTAssertEqual(
            MarkdownEditor.applying(.quote, to: "said", selection: NSRange(location: 0, length: 0)).text,
            "> said"
        )
    }

    func testALinePrefixOnlyTouchesTheLineHoldingTheCaret() {
        let text = "first\nsecond\nthird"
        let caretInSecond = NSRange(location: 8, length: 0)

        let edit = MarkdownEditor.applying(.bullet, to: text, selection: caretInSecond)

        XCTAssertEqual(edit.text, "first\n- second\nthird")
        XCTAssertEqual(edit.selectedRange, NSRange(location: 10, length: 0))
    }

    // MARK: - List continuation

    func testReturnInsideABulletContinuesTheList() {
        let edit = MarkdownEditor.continuingList(
            in: "- first",
            at: NSRange(location: 7, length: 0)
        )

        XCTAssertEqual(edit?.text, "- first\n- ")
        XCTAssertEqual(edit?.selectedRange, NSRange(location: 10, length: 0))
    }

    func testReturnInsideAnOrderedItemIncrementsTheNumber() {
        let edit = MarkdownEditor.continuingList(
            in: "3. third",
            at: NSRange(location: 8, length: 0)
        )

        XCTAssertEqual(edit?.text, "3. third\n4. ")
    }

    func testReturnInsideATaskItemStartsAnUncheckedOne() {
        let edit = MarkdownEditor.continuingList(
            in: "- [x] done",
            at: NSRange(location: 10, length: 0)
        )

        XCTAssertEqual(edit?.text, "- [x] done\n- [ ] ")
    }

    func testIndentationCarriesToTheNextItem() {
        let edit = MarkdownEditor.continuingList(
            in: "  - nested",
            at: NSRange(location: 10, length: 0)
        )

        XCTAssertEqual(edit?.text, "  - nested\n  - ")
    }

    func testReturnOnAnEmptyItemEndsTheListInsteadOfAddingAnother() {
        let edit = MarkdownEditor.continuingList(
            in: "- first\n- ",
            at: NSRange(location: 10, length: 0)
        )

        XCTAssertEqual(edit?.text, "- first\n")
        XCTAssertEqual(edit?.selectedRange, NSRange(location: 8, length: 0))
    }

    func testReturnOutsideAListIsLeftToTheTextView() {
        XCTAssertNil(
            MarkdownEditor.continuingList(in: "just prose", at: NSRange(location: 10, length: 0))
        )
        XCTAssertNil(
            MarkdownEditor.continuingList(in: "-nospace", at: NSRange(location: 8, length: 0))
        )
    }
}
