import ClepsydraCore
import XCTest

final class ServerURLTests: XCTestCase {
    func testNormalizesWhitespaceAndSingleTrailingSlash() throws {
        let server = try ServerURL(" https://clepsydra.tail-example.ts.net:16667/ ")

        XCTAssertEqual(server.url.absoluteString, "https://clepsydra.tail-example.ts.net:16667")
    }

    func testPreservesHTTPSHostAndPort() throws {
        let server = try ServerURL("https://vault.example.test:8443")

        XCTAssertEqual(server.url.host, "vault.example.test")
        XCTAssertEqual(server.url.port, 8443)
    }

    func testRejectsNonHTTPS() {
        XCTAssertThrowsError(try ServerURL("http://clepsydra.tail-example.ts.net:16667"))
    }

    func testRejectsCredentials() {
        XCTAssertThrowsError(try ServerURL("https://user:pass@clepsydra.tail-example.ts.net"))
    }

    func testRejectsQueryAndFragment() {
        XCTAssertThrowsError(try ServerURL("https://clepsydra.tail-example.ts.net?x=1"))
        XCTAssertThrowsError(try ServerURL("https://clepsydra.tail-example.ts.net#section"))
    }

    func testRejectsInternalAPIPath() {
        XCTAssertThrowsError(try ServerURL("https://clepsydra.tail-example.ts.net/api/vault"))
        XCTAssertThrowsError(try ServerURL("https://clepsydra.tail-example.ts.net/vault"))
    }
}
