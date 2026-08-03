import Foundation

public struct ServerURL: Equatable, Hashable, Sendable {
    public let url: URL

    public init(_ rawValue: String) throws {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, var components = URLComponents(string: value) else {
            throw ServerURLError.invalidURL
        }
        guard components.scheme?.lowercased() == "https" else {
            throw ServerURLError.insecureScheme
        }
        guard let host = components.host, !host.isEmpty else {
            throw ServerURLError.missingHost
        }
        guard components.user == nil, components.password == nil else {
            throw ServerURLError.credentialsNotAllowed
        }
        guard components.query == nil else {
            throw ServerURLError.queryNotAllowed
        }
        guard components.fragment == nil else {
            throw ServerURLError.fragmentNotAllowed
        }
        guard components.path.isEmpty || components.path == "/" else {
            throw ServerURLError.pathNotAllowed
        }

        components.path = ""
        guard let normalizedURL = components.url, normalizedURL.scheme?.lowercased() == "https" else {
            throw ServerURLError.invalidURL
        }
        self.url = normalizedURL
    }
}

public enum ServerURLError: Error, Equatable, Sendable {
    case invalidURL
    case insecureScheme
    case missingHost
    case credentialsNotAllowed
    case queryNotAllowed
    case fragmentNotAllowed
    case pathNotAllowed
}
