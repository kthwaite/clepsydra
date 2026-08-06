import Foundation

public typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

public struct APIClient: VaultAPI, Sendable {
    private let server: ServerURL
    private let transport: HTTPTransport
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let timeout: TimeInterval

    public init(
        server: ServerURL,
        transport: @escaping HTTPTransport,
        timeout: TimeInterval = 30
    ) {
        self.server = server
        self.transport = transport
        self.encoder = VaultAPIJSON.encoder()
        self.decoder = VaultAPIJSON.decoder()
        self.timeout = timeout.isFinite && timeout > 0 ? timeout : 30
    }

    public init(server: ServerURL, timeout: TimeInterval = 30) {
        self.init(server: server, transport: { request in
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            return (data, response)
        }, timeout: timeout)
    }

    public func uptime() async throws {
        let request = try makeRequest(operation: "uptime", path: "/api/vault/uptime")
        _ = try await send(request, operation: "uptime")
    }

    public func search(query: String, limit: Int) async throws -> [SearchResult] {
        let request = try makeRequest(
            operation: "search",
            path: "/api/vault/index/search",
            queryItems: [
                URLQueryItem(name: "q", value: query),
                URLQueryItem(name: "limit", value: String(limit))
            ]
        )
        return try decode([SearchResult].self, from: try await send(request, operation: "search"), operation: "search")
    }

    public func page(id: UUID) async throws -> PageDetail {
        let request = try makeRequest(
            operation: "page",
            path: "/api/vault/pages/by-id/\(id.uuidString.lowercased())"
        )
        return try decode(PageDetail.self, from: try await send(request, operation: "page"), operation: "page")
    }

    public func createPage(_ requestBody: CreatePageRequest) async throws -> PageDetail {
        let request = try makeRequest(
            operation: "createPage",
            path: "/api/vault/pages",
            method: "POST",
            body: try encode(requestBody, operation: "createPage")
        )
        return try decode(
            PageDetail.self,
            from: try await send(request, operation: "createPage"),
            operation: "createPage"
        )
    }

    public func updatePage(id: UUID, request requestBody: UpdatePageRequest) async throws -> PageDetail {
        let request = try makeRequest(
            operation: "updatePage",
            path: "/api/vault/pages/by-id/\(id.uuidString.lowercased())",
            method: "PUT",
            body: try encode(requestBody, operation: "updatePage")
        )
        return try decode(
            PageDetail.self,
            from: try await send(request, operation: "updatePage"),
            operation: "updatePage"
        )
    }

    private func makeRequest(
        operation: String,
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: Data? = nil
    ) throws -> URLRequest {
        var components = URLComponents(url: server.url, resolvingAgainstBaseURL: false)
        components?.path = path
        components?.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components?.url else {
            throw VaultAPIError.other("Unable to construct URL for \(operation).")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func encode<T: Encodable>(_ value: T, operation: String) throws -> Data {
        do {
            return try encoder.encode(value)
        } catch {
            throw VaultAPIError.decoding(operation: operation, message: error.localizedDescription)
        }
    }

    private func send(_ request: URLRequest, operation: String) async throws -> Data {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport(request)
        } catch let error as URLError {
            throw map(error)
        } catch {
            throw VaultAPIError.other(error.localizedDescription)
        }

        guard (200..<300).contains(response.statusCode) else {
            throw serverError(status: response.statusCode, data: data)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, operation: String) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw VaultAPIError.decoding(operation: operation, message: error.localizedDescription)
        }
    }

    private func map(_ error: URLError) -> VaultAPIError {
        switch error.code {
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
            return .unreachable
        case .secureConnectionFailed, .serverCertificateUntrusted, .clientCertificateRejected, .clientCertificateRequired:
            return .tls
        case .timedOut:
            return .timedOut
        default:
            return .other(error.localizedDescription)
        }
    }

    private func serverError(status: Int, data: Data) -> VaultAPIError {
        guard let envelope = try? decoder.decode(ErrorEnvelope.self, from: data) else {
            return .server(status: status, message: "Server returned HTTP \(status).")
        }
        if envelope.detail?.code == "revision_conflict",
           let currentRevision = envelope.detail?.currentRevision,
           !currentRevision.isEmpty {
            return .revisionConflict(currentRevision: currentRevision)
        }
        return .server(status: status, message: envelope.error)
    }

    private struct ErrorEnvelope: Decodable {
        struct Detail: Decodable {
            let code: String?
            let currentRevision: String?
        }

        let error: String
        let detail: Detail?
    }
}
