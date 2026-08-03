import XCTest
@testable import ClepsydraCore

final class SearchSnippetTests: XCTestCase {
    func testParsesExactMarkTokensIntoLiteralAndHighlightedSegments() {
        XCTAssertEqual(
            SearchSnippet.parse("before <mark>match</mark> after"),
            [
                .init(text: "before ", highlighted: false),
                .init(text: "match", highlighted: true),
                .init(text: " after", highlighted: false),
            ]
        )
    }

    func testLeavesHTMLLikeTextLiteral() {
        XCTAssertEqual(
            SearchSnippet.parse("<script>alert(1)</script>"),
            [.init(text: "<script>alert(1)</script>", highlighted: false)]
        )
    }

    func testLeavesUnmatchedOpeningTokenLiteral() {
        XCTAssertEqual(
            SearchSnippet.parse("before <mark>unclosed"),
            [.init(text: "before <mark>unclosed", highlighted: false)]
        )
    }

    func testLeavesUnmatchedClosingTokenLiteral() {
        XCTAssertEqual(
            SearchSnippet.parse("before </mark> after"),
            [.init(text: "before </mark> after", highlighted: false)]
        )
    }
}
