import Foundation
import ClepsydraCore
import XCTest

final class APIClientTests: XCTestCase {
    private let baseURL = "https://vault.example.test:8443"
    private let pageID = UUID(uuidString: "01900000-0000-7000-8000-000000000001")!

    func testSearchPercentEncodesQueryAndSendsLimitTwenty() async throws {
        let recorder = RequestRecorder()
        let response = try makeResponse(status: 200)
        let resultJSON = "[]"
        let client = try makeClient(recorder: recorder, data: Data(resultJSON.utf8), response: response)

        _ = try await client.search(query: "hello world &swift", limit: 20)

        let request = await recorder.lastRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://vault.example.test:8443/api/vault/index/search?q=hello%20world%20%26swift&limit=20"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
    }

    func testPageReadUsesUUIDPath() async throws {
        let recorder = RequestRecorder()
        let response = try makeResponse(status: 200)
        let client = try makeClient(recorder: recorder, data: pageData(), response: response)

        let page = try await client.page(id: pageID)

        XCTAssertEqual(page.id, pageID)
        let request = await recorder.lastRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://vault.example.test:8443/api/vault/pages/by-id/01900000-0000-7000-8000-000000000001"
        )
    }

    func testCreateUsesPOSTAndSnakeCaseJSON() async throws {
        let recorder = RequestRecorder()
        let response = try makeResponse(status: 201)
        let client = try makeClient(recorder: recorder, data: pageData(), response: response)
        let requestBody = CreatePageRequest(title: "A page", body: "Body")

        _ = try await client.createPage(requestBody)

        let request = await recorder.lastRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/vault/pages")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let object = try XCTUnwrap(request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])
        XCTAssertEqual(object["title"] as? String, "A page")
        XCTAssertEqual(object["body"] as? String, "Body")
    }

    func testUpdateUsesPUTAndEncodesExpectedRevision() async throws {
        let recorder = RequestRecorder()
        let response = try makeResponse(status: 200)
        let client = try makeClient(recorder: recorder, data: pageData(), response: response)
        let revision = String(repeating: "b", count: 64)
        let requestBody = UpdatePageRequest(
            expectedRevision: revision,
            title: "Updated",
            tags: ["swift"],
            aliases: nil,
            body: "New body"
        )

        _ = try await client.updatePage(id: pageID, request: requestBody)

        let request = await recorder.lastRequest()
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://vault.example.test:8443/api/vault/pages/by-id/01900000-0000-7000-8000-000000000001"
        )
        let object = try XCTUnwrap(request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])
        XCTAssertEqual(object["expected_revision"] as? String, revision)
        XCTAssertEqual(object["tags"] as? [String], ["swift"])
        XCTAssertEqual(object["title"] as? String, "Updated")
    }

    func testUptimeAcceptsAnyTwoHundredStatusWithEmptyBody() async throws {
        let recorder = RequestRecorder()
        let response = try makeResponse(status: 204)
        let client = try makeClient(recorder: recorder, data: Data(), response: response)

        try await client.uptime()

        let request = await recorder.lastRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/vault/uptime")
    }

    func testMalformedSuccessJSONMapsToOperationAwareDecodingError() async throws {
        let response = try makeResponse(status: 200)
        let client = try makeClient(recorder: RequestRecorder(), data: Data("not json".utf8), response: response)

        do {
            _ = try await client.page(id: pageID)
            XCTFail("Expected decoding failure")
        } catch let error as VaultAPIError {
            guard case let .decoding(operation, message) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(operation, "page")
            XCTAssertFalse(message.isEmpty)
        }
    }

    func testEmptySuccessBodyMapsToDecodingErrorForDecodedOperation() async throws {
        let response = try makeResponse(status: 204)
        let client = try makeClient(recorder: RequestRecorder(), data: Data(), response: response)

        do {
            _ = try await client.search(query: "query", limit: 1)
            XCTFail("Expected decoding failure")
        } catch let error as VaultAPIError {
            XCTAssertEqual(error.operation, "search")
        }
    }

    func testRevisionConflictPayloadMapsToStructuredConflict() async throws {
        let recorder = RequestRecorder()
        let response = try makeResponse(status: 409)
        let revision = String(repeating: "c", count: 64)
        let payload = "{\"error\":\"conflict\",\"detail\":{\"code\":\"revision_conflict\",\"current_revision\":\"\(revision)\"}}"
        let client = try makeClient(recorder: recorder, data: Data(payload.utf8), response: response)

        do {
            _ = try await client.page(id: pageID)
            XCTFail("Expected conflict")
        } catch let error as VaultAPIError {
            XCTAssertEqual(error, .revisionConflict(currentRevision: revision))
        }
    }

    func testNotFoundAndServerFailureMapToHTTPServerErrors() async throws {
        let notFound = try makeClient(recorder: RequestRecorder(), data: Data("{\"error\":\"missing\"}".utf8), response: try makeResponse(status: 404))
        let serverFailure = try makeClient(recorder: RequestRecorder(), data: Data("{\"error\":\"broken\"}".utf8), response: try makeResponse(status: 500))

        do {
            _ = try await notFound.page(id: pageID)
            XCTFail("Expected not found")
        } catch let error as VaultAPIError {
            XCTAssertEqual(error, .server(status: 404, message: "missing"))
        }

        do {
            _ = try await serverFailure.page(id: pageID)
            XCTFail("Expected server failure")
        } catch let error as VaultAPIError {
            XCTAssertEqual(error, .server(status: 500, message: "broken"))
        }
    }

    func testUnreachableTLSAndTimeoutRemainDistinct() async throws {
        let codes: [(URLError.Code, VaultAPIError)] = [
            (.cannotConnectToHost, .unreachable),
            (.secureConnectionFailed, .tls),
            (.serverCertificateUntrusted, .tls),
            (.timedOut, .timedOut)
        ]

        for (code, expected) in codes {
            let client = try APIClient(server: ServerURL(baseURL), transport: { _ in
                throw URLError(code)
            })

            do {
                try await client.uptime()
                XCTFail("Expected transport error for \(code)")
            } catch let error as VaultAPIError {
                XCTAssertEqual(error, expected)
            }
        }
    }

    func testOtherTransportErrorPreservesDescription() async throws {
        let client = try APIClient(server: ServerURL(baseURL), transport: { _ in
            throw URLError(.networkConnectionLost)
        })

        do {
            try await client.uptime()
            XCTFail("Expected transport error")
        } catch let error as VaultAPIError {
            guard case let .other(message) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertFalse(message.isEmpty)
        }
    }

    private func makeClient(
        recorder: RequestRecorder,
        data: Data,
        response: HTTPURLResponse
    ) throws -> APIClient {
        try APIClient(server: ServerURL(baseURL), transport: { request in
            await recorder.record(request)
            return (data, response)
        })
    }

    private func makeResponse(status: Int) throws -> HTTPURLResponse {
        try XCTUnwrap(HTTPURLResponse(
            url: XCTUnwrap(URL(string: baseURL)),
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        ))
    }

    private func pageData() -> Data {
        let revision = String(repeating: "a", count: 64)
        let json = """
        {
          "path": "notes/page.md",
          "canonical_name": "page",
          "meta": {
            "id": "01900000-0000-7000-8000-000000000001",
            "title": "Page",
            "tags": [],
            "aliases": [],
            "created_at": null,
            "updated_at": null
          },
          "body": "Page body",
          "revision": "\(revision)",
          "kind": "NOTE",
          "inferred": false,
          "project": null
        }
        """
        return Data(json.utf8)
    }
}

private actor RequestRecorder {
    private var requests: [URLRequest] = []

    func record(_ request: URLRequest) {
        requests.append(request)
    }

    func lastRequest() -> URLRequest {
        requests[requests.count - 1]
    }
}
