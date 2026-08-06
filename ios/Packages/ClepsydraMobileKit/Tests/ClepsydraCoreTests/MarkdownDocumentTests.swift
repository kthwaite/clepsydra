import ClepsydraCore
import XCTest

final class MarkdownDocumentTests: XCTestCase {
    func testAQuoteAndTheParagraphAfterItStaySeparateBlocks() {
        // The defect this parser exists to fix: rendering the whole document as
        // one AttributedString ran these together as "…achieve this?Short version".
        let blocks = MarkdownDocument.blocks(
            from: """
            > a quoted question?

            Short version: an answer.
            """
        )

        XCTAssertEqual(
            blocks,
            [
                .quote([.paragraph("a quoted question?")]),
                .paragraph("Short version: an answer."),
            ]
        )
    }

    func testHeadingsCarryTheirLevelAndDropDecoration() {
        let blocks = MarkdownDocument.blocks(
            from: """
            # One

            ### Three ###
            """
        )

        XCTAssertEqual(blocks, [.heading(level: 1, text: "One"), .heading(level: 3, text: "Three")])
    }

    func testAHashWithoutASpaceIsNotAHeading() {
        XCTAssertEqual(
            MarkdownDocument.blocks(from: "#hashtag not a heading"),
            [.paragraph("#hashtag not a heading")]
        )
    }

    func testAParagraphEndsWhereTheNextBlockStartsWithoutABlankLine() {
        let blocks = MarkdownDocument.blocks(
            from: """
            prose text
            ## Heading
            """
        )

        XCTAssertEqual(blocks, [.paragraph("prose text"), .heading(level: 2, text: "Heading")])
    }

    func testFencedCodeKeepsItsLanguageAndContentVerbatim() {
        let blocks = MarkdownDocument.blocks(
            from: """
            ```swift
            let value = 1

            # not a heading
            ```
            """
        )

        XCTAssertEqual(blocks, [.code(language: "swift", text: "let value = 1\n\n# not a heading")])
    }

    func testAnUnterminatedFenceRunsToTheEndInsteadOfSwallowingNothing() {
        let blocks = MarkdownDocument.blocks(
            from: """
            ```
            dangling
            """
        )

        XCTAssertEqual(blocks, [.code(language: nil, text: "dangling")])
    }

    func testTaskItemsRecordTheirCheckedState() {
        let blocks = MarkdownDocument.blocks(
            from: """
            - [x] done
            - [ ] todo
            - plain
            """
        )

        XCTAssertEqual(
            blocks,
            [
                .list(
                    ordered: false,
                    items: [
                        MarkdownListItem(marker: .task(done: true), text: "done"),
                        MarkdownListItem(marker: .task(done: false), text: "todo"),
                        MarkdownListItem(marker: .bullet, text: "plain"),
                    ]
                )
            ]
        )
    }

    func testOrderedListsKeepTheirNumbers() {
        let blocks = MarkdownDocument.blocks(
            from: """
            3. third
            4. fourth
            """
        )

        XCTAssertEqual(
            blocks,
            [
                .list(
                    ordered: true,
                    items: [
                        MarkdownListItem(marker: .ordered(3), text: "third"),
                        MarkdownListItem(marker: .ordered(4), text: "fourth"),
                    ]
                )
            ]
        )
    }

    func testNestedItemsRecordDepthRatherThanColumns() {
        let blocks = MarkdownDocument.blocks(
            from: """
            - top
              - nested
            """
        )

        XCTAssertEqual(
            blocks,
            [
                .list(
                    ordered: false,
                    items: [
                        MarkdownListItem(marker: .bullet, indent: 0, text: "top"),
                        MarkdownListItem(marker: .bullet, indent: 1, text: "nested"),
                    ]
                )
            ]
        )
    }

    func testAWrappedItemLineRejoinsItsItem() {
        let blocks = MarkdownDocument.blocks(
            from: """
            - an item that
              wraps
            """
        )

        XCTAssertEqual(
            blocks,
            [.list(ordered: false, items: [MarkdownListItem(marker: .bullet, text: "an item that wraps")])]
        )
    }

    func testThematicBreaksAreNotMistakenForListsOrHeadings() {
        XCTAssertEqual(MarkdownDocument.blocks(from: "---"), [.thematicBreak])
        XCTAssertEqual(MarkdownDocument.blocks(from: "* * *"), [.thematicBreak])
    }

    func testATableIsKeptVerbatimForMonospacedDisplay() {
        let source = """
        | Name | Value |
        | --- | --- |
        | one | two |
        """

        XCTAssertEqual(MarkdownDocument.blocks(from: source), [.table(source)])
    }

    func testPipesWithoutADelimiterRowStayProse() {
        XCTAssertEqual(
            MarkdownDocument.blocks(from: "a | b is not a table"),
            [.paragraph("a | b is not a table")]
        )
    }

    func testCarriageReturnsAreNormalizedBeforeParsing() {
        XCTAssertEqual(
            MarkdownDocument.blocks(from: "# One\r\n\r\ntext"),
            [.heading(level: 1, text: "One"), .paragraph("text")]
        )
    }

    func testQuotesContainTheirOwnBlockStructure() {
        let blocks = MarkdownDocument.blocks(
            from: """
            > ## Inside
            >
            > - listed
            """
        )

        XCTAssertEqual(
            blocks,
            [
                .quote([
                    .heading(level: 2, text: "Inside"),
                    .list(ordered: false, items: [MarkdownListItem(marker: .bullet, text: "listed")]),
                ])
            ]
        )
    }

    func testEmptyInputProducesNoBlocks() {
        XCTAssertEqual(MarkdownDocument.blocks(from: ""), [])
        XCTAssertEqual(MarkdownDocument.blocks(from: "\n\n  \n"), [])
    }
}
