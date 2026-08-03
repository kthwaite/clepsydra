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
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.size.width ?? 0, 0)
        XCTAssertGreaterThan(image?.size.height ?? 0, 0)
        #else
        let image = renderer.nsImage
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.size.width ?? 0, 0)
        XCTAssertGreaterThan(image?.size.height ?? 0, 0)
        #endif
    }

    func testNormalizesTaskMarkersAndLineEndings() {
        let markdown = "- [x] done\r\n- [ ] todo"

        XCTAssertEqual(
            MarkdownPreview.normalizedMarkdown(markdown),
            "- ☑ done\n- ☐ todo"
        )
    }

    func testRetainsHTTPSLinksButRemovesUnsafeLinkDestinations() throws {
        let normalized = MarkdownPreview.normalizedMarkdown(
            "[safe](https://example.com) [http](http://example.com) [unsafe](javascript:alert(1))"
        )
        let rendered = try AttributedString(markdown: normalized)
        let links = rendered.runs.compactMap(\.link)

        XCTAssertEqual(links, [URL(string: "https://example.com")!])
        XCTAssertFalse(normalized.contains("http://"))
        XCTAssertFalse(normalized.contains("javascript:"))
    }
}
