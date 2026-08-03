import ClepsydraCore
import XCTest

final class VaultAPIErrorTests: XCTestCase {
    func testRevisionConflictPreservesStructuredCurrentRevision() {
        let revision = String(repeating: "c", count: 64)
        let error = VaultAPIError.revisionConflict(currentRevision: revision)

        XCTAssertEqual(error, .revisionConflict(currentRevision: revision))
        XCTAssertEqual(error.currentRevision, revision)
        XCTAssertEqual(error.userMessage, "This page changed on the server. Reload it before saving again.")
    }

    func testTransportCategoriesRemainDistinctAndUserPresentable() {
        XCTAssertNotEqual(VaultAPIError.unreachable, .tls)
        XCTAssertNotEqual(VaultAPIError.tls, .timedOut)
        XCTAssertNotEqual(VaultAPIError.timedOut, .other("network failure"))
        XCTAssertFalse(VaultAPIError.unreachable.userMessage.isEmpty)
        XCTAssertFalse(VaultAPIError.tls.userMessage.isEmpty)
        XCTAssertFalse(VaultAPIError.timedOut.userMessage.isEmpty)
    }

    func testServerAndDecodingErrorsRetainDetails() {
        let server = VaultAPIError.server(status: 404, message: "page not found")
        let decoding = VaultAPIError.decoding(operation: "page", message: "unexpected end of file")

        XCTAssertEqual(server, .server(status: 404, message: "page not found"))
        XCTAssertEqual(server.userMessage, "page not found")
        XCTAssertEqual(decoding.operation, "page")
        XCTAssertTrue(decoding.userMessage.contains("page"))
    }
}
