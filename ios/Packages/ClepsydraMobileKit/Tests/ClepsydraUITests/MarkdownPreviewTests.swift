import Foundation
import SwiftUI
import XCTest
@testable import ClepsydraUI

@MainActor
final class MarkdownPreviewTests: XCTestCase {
    func testRepresentativeMarkdownRendersAtFixedWidth() {
        let fixture = """
        # Heading

        *emphasis* and **strong** text.

        - unordered
        - [x] completed task
        - [ ] open task

        1. ordered

        > quoted text

        ```swift
        let value = 1
        ```

        Inline `code` and [ordinary link](https://example.com).

        ---

        | Name | Value |
        | --- | --- |
        | one | two |

        ~~strikethrough~~ and [[Wiki Target]].
        """

        let renderer = ImageRenderer(
            content: MarkdownPreview(markdown: fixture)
                .frame(width: 390)
        )
        renderer.scale = 1

        #if os(iOS)
        let image = renderer.uiImage
        #else
        let image = renderer.nsImage
        #endif
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.size.width ?? 0, 0)
        XCTAssertGreaterThan(image?.size.height ?? 0, 0)
    }

    func testSeparateBlocksOccupyMoreHeightThanOneRunOfText() throws {
        // A regression guard for the original defect: when every block was
        // flattened into a single AttributedString, a quote plus two headings
        // laid out as one paragraph-sized blob.
        let structured = try heightOfRendering(
            """
            > quoted

            ## Heading

            Body text.
            """
        )
        let flattened = try heightOfRendering("quoted Heading Body text.")

        XCTAssertGreaterThan(structured, flattened)
    }

    func testInlineRenderingKeepsHTTPSLinksAndDropsUnsafeOnes() {
        let rendered = MarkdownInline.attributed(
            "[safe](https://example.com) [unsafe](javascript:alert(1))"
        )

        XCTAssertEqual(rendered.runs.compactMap(\.link), [URL(string: "https://example.com")!])
        XCTAssertFalse(String(rendered.characters).contains("javascript:"))
    }

    func testInlineRenderingRecoversAngleBracketedLinks() {
        let rendered = MarkdownInline.attributed("[QYARIA](<https://example.com/a-b/>)")

        XCTAssertEqual(
            rendered.runs.compactMap(\.link),
            [URL(string: "https://example.com/a-b/")!]
        )
    }

    func testInlineRenderingLeavesBlockSyntaxAlone() {
        // Block markers reaching this layer would mean MarkdownDocument missed
        // them; interpreting them again is what caused the flattening.
        let rendered = MarkdownInline.attributed("**bold** text")

        XCTAssertEqual(String(rendered.characters), "bold text")
    }

    private func heightOfRendering(_ markdown: String) throws -> CGFloat {
        let renderer = ImageRenderer(
            content: MarkdownPreview(markdown: markdown).frame(width: 390)
        )
        renderer.scale = 1
        #if os(iOS)
        let image = renderer.uiImage
        #else
        let image = renderer.nsImage
        #endif
        return try XCTUnwrap(image).size.height
    }
}
