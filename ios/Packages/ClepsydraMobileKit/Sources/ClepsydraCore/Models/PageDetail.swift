import Foundation

public enum VaultAPIJSON {
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

public struct PageMeta: Codable, Equatable, Sendable {
    public let id: UUID
    public let title: String?
    public let tags: [String]
    public let aliases: [String]
    public let createdAt: Date?
    public let updatedAt: Date?

    public init(
        id: UUID,
        title: String?,
        tags: [String],
        aliases: [String],
        createdAt: Date?,
        updatedAt: Date?
    ) {
        self.id = id
        self.title = title
        self.tags = tags
        self.aliases = aliases
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct PageDetail: Codable, Equatable, Sendable, Identifiable {
    public var id: UUID { meta.id }
    public let path: String
    public let canonicalName: String
    public let meta: PageMeta
    public let body: String
    public let revision: String
    public let kind: String
    public let inferred: Bool
    public let project: String?

    public init(
        path: String,
        canonicalName: String,
        meta: PageMeta,
        body: String,
        revision: String,
        kind: String,
        inferred: Bool,
        project: String?
    ) {
        self.path = path
        self.canonicalName = canonicalName
        self.meta = meta
        self.body = body
        self.revision = revision
        self.kind = kind
        self.inferred = inferred
        self.project = project
    }
}

public struct CreatePageRequest: Codable, Equatable, Sendable {
    public let title: String
    public let body: String?

    public init(title: String, body: String?) {
        self.title = title
        self.body = body
    }
}

public struct UpdatePageRequest: Codable, Equatable, Sendable {
    public let expectedRevision: String
    public let title: String?
    public let body: String?

    public init(expectedRevision: String, title: String?, body: String?) {
        self.expectedRevision = expectedRevision
        self.title = title
        self.body = body
    }
}
