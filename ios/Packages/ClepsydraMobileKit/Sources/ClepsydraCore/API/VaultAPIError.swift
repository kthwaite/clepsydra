import Foundation

public struct RevisionConflictDetail: Codable, Equatable, Sendable {
    public let code: String
    public let currentRevision: String

    public init(currentRevision: String) {
        self.code = "revision_conflict"
        self.currentRevision = currentRevision
    }
}

public enum VaultAPIError: Error, Equatable, Sendable, LocalizedError {
    case unreachable
    case tls
    case timedOut
    case other(String)
    case server(status: Int, message: String)
    case revisionConflict(currentRevision: String)
    case decoding(operation: String, message: String)

    public var currentRevision: String? {
        guard case let .revisionConflict(currentRevision) = self else { return nil }
        return currentRevision
    }

    public var operation: String? {
        guard case let .decoding(operation, _) = self else { return nil }
        return operation
    }

    public var userMessage: String {
        switch self {
        case .unreachable:
            return "The Clepsydra server could not be reached."
        case .tls:
            return "The Clepsydra server's TLS certificate could not be trusted."
        case .timedOut:
            return "The Clepsydra server took too long to respond."
        case let .other(message):
            return message
        case let .server(_, message):
            return message
        case .revisionConflict:
            return "This page changed on the server. Reload it before saving again."
        case let .decoding(operation, message):
            return "The server returned invalid data while performing \(operation): \(message)"
        }
    }

    public var errorDescription: String? { userMessage }
}
