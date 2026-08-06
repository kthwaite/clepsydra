import ClepsydraCore
import XCTest

final class MarkdownLinkSanitizerTests: XCTestCase {
    func testHTTPSDestinationsSurvive() {
        XCTAssertEqual(
            MarkdownLinkSanitizer.sanitizingDestinations(in: "[safe](https://example.com)"),
            "[safe](https://example.com)"
        )
    }

    func testAngleBracketedHTTPSIsUnwrappedRatherThanDeleted() {
        // The QYARIA regression: `URL(string:)` rejects the angle brackets, so
        // a perfectly good link was classed unsafe and silently emptied.
        XCTAssertEqual(
            MarkdownLinkSanitizer.sanitizingDestinations(in: "[QYARIA](<https://example.com/a-b/>)"),
            "[QYARIA](https://example.com/a-b/)"
        )
    }

    func testNonHTTPSDestinationsAreEmptied() {
        for source in [
            "[x](http://example.com)",
            "[x](javascript:alert(1))",
            "[x](data:text/html;base64,AAA)",
            "[x](file:///etc/passwd)",
            "[x](/relative/path)",
        ] {
            XCTAssertEqual(
                MarkdownLinkSanitizer.sanitizingDestinations(in: source),
                "[x]()",
                "expected \(source) to lose its destination"
            )
        }
    }

    func testEveryLinkOnALineIsInspected() {
        XCTAssertEqual(
            MarkdownLinkSanitizer.sanitizingDestinations(
                in: "[a](https://a.example) [b](http://b.example) [c](<https://c.example>)"
            ),
            "[a](https://a.example) [b]() [c](https://c.example)"
        )
    }

    func testParenthesesInsideADestinationDoNotEndItEarly() {
        XCTAssertEqual(
            MarkdownLinkSanitizer.sanitizingDestinations(
                in: "[wiki](https://en.wikipedia.org/wiki/Foo_(bar))"
            ),
            "[wiki](https://en.wikipedia.org/wiki/Foo_(bar))"
        )
    }

    func testATitleAfterTheDestinationIsPreserved() {
        XCTAssertEqual(
            MarkdownLinkSanitizer.sanitizingDestinations(in: "[a](https://a.example \"Title\")"),
            "[a](https://a.example \"Title\")"
        )
    }

    func testTextWithoutLinksIsUnchanged() {
        let source = "plain text with (parens) and a ] bracket"
        XCTAssertEqual(MarkdownLinkSanitizer.sanitizingDestinations(in: source), source)
    }
}
