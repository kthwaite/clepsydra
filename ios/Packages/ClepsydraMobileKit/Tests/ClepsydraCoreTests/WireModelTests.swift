import Foundation
import ClepsydraCore
import XCTest

final class WireModelTests: XCTestCase {
    func testDecodesCompletePageDetailFixture() throws {
        let pageID = UUID(uuidString: "01900000-0000-7000-8000-000000000001")!
        let revision = String(repeating: "a", count: 64)
        let payload = """
        {
          "path": "notes/page.md",
          "canonical_name": "page",
          "meta": {
            "id": "01900000-0000-7000-8000-000000000001",
            "title": "Page title",
            "tags": ["swift", "ios"],
            "aliases": ["the page"],
            "created_at": "2025-02-16T12:34:56Z",
            "updated_at": "2025-02-17T12:34:56Z"
          },
          "body": "Page body",
          "revision": "\(revision)",
          "kind": "NOTE",
          "inferred": false,
          "project": "clepsydra"
        }
        """.data(using: .utf8)!

        let page = try VaultAPIJSON.decoder().decode(PageDetail.self, from: payload)

        XCTAssertEqual(page.id, pageID)
        XCTAssertEqual(page.path, "notes/page.md")
        XCTAssertEqual(page.canonicalName, "page")
        XCTAssertEqual(page.meta.id, pageID)
        XCTAssertEqual(page.meta.title, "Page title")
        XCTAssertEqual(page.meta.tags, ["swift", "ios"])
        XCTAssertEqual(page.meta.aliases, ["the page"])
        XCTAssertEqual(page.meta.createdAt, ISO8601DateFormatter().date(from: "2025-02-16T12:34:56Z"))
        XCTAssertEqual(page.meta.updatedAt, ISO8601DateFormatter().date(from: "2025-02-17T12:34:56Z"))
        XCTAssertEqual(page.body, "Page body")
        XCTAssertEqual(page.revision, revision)
        XCTAssertEqual(page.kind, "NOTE")
        XCTAssertFalse(page.inferred)
        XCTAssertEqual(page.project, "clepsydra")
    }

    func testDecodesMissingOrNullTagAndAliasArraysAsEmpty() throws {
        let payloads = [
            """
            {"path":"note.md","canonical_name":"note","meta":{"id":"01900000-0000-7000-8000-000000000003"},"body":"","revision":"\(String(repeating: "d", count: 64))","kind":"NOTE","inferred":true}
            """,
            """
            {"path":"note.md","canonical_name":"note","meta":{"id":"01900000-0000-7000-8000-000000000003","tags":null,"aliases":null},"body":"","revision":"\(String(repeating: "d", count: 64))","kind":"NOTE","inferred":true}
            """
        ]

        for payload in payloads {
            let page = try VaultAPIJSON.decoder().decode(PageDetail.self, from: Data(payload.utf8))

            XCTAssertEqual(page.meta.tags, [])
            XCTAssertEqual(page.meta.aliases, [])
        }
    }

    func testEncodesRequestsWithOpenAPIWireNames() throws {
        let create = CreatePageRequest(title: "A page", body: "Body")
        let update = UpdatePageRequest(
            expectedRevision: String(repeating: "b", count: 64),
            title: nil,
            tags: ["swift", "ios"],
            aliases: ["mobile"],
            body: "New body"
        )

        let createJSON = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: VaultAPIJSON.encoder().encode(create)) as? [String: Any]
        )
        let updateJSON = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: VaultAPIJSON.encoder().encode(update)) as? [String: Any]
        )

        XCTAssertEqual(createJSON["title"] as? String, "A page")
        XCTAssertEqual(createJSON["body"] as? String, "Body")
        XCTAssertEqual(updateJSON["tags"] as? [String], ["swift", "ios"])
        XCTAssertEqual(updateJSON["aliases"] as? [String], ["mobile"])
        XCTAssertEqual(updateJSON["expected_revision"] as? String, String(repeating: "b", count: 64))
        XCTAssertEqual(updateJSON["body"] as? String, "New body")
        XCTAssertNil(updateJSON["title"] as? String)
    }

    func testSearchResultUsesStablePageIDAsIdentity() throws {
        let pageID = UUID(uuidString: "01900000-0000-7000-8000-000000000002")!
        let payload = """
        {"page_id":"01900000-0000-7000-8000-000000000002","path":"notes/page.md","title":null,"snippet":"Page snippet"}
        """.data(using: .utf8)!

        let result = try VaultAPIJSON.decoder().decode(SearchResult.self, from: payload)

        XCTAssertEqual(result.id, pageID)
        XCTAssertEqual(result.pageID, pageID)
        XCTAssertNil(result.title)
        XCTAssertEqual(result.snippet, "Page snippet")
    }
}
