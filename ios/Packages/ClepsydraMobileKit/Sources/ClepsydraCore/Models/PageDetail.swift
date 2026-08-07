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

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case tags
        case aliases
        case createdAt
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        aliases = try container.decodeIfPresent([String].self, forKey: .aliases) ?? []
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
    }
}

public struct PageEncryptionDescriptor: Codable, Equatable, Sendable {
    public let format: String
    public let version: Int
    public let keyID: String

    public init(format: String, version: Int, keyID: String) {
        self.format = format
        self.version = version
        self.keyID = keyID
    }

    private enum CodingKeys: String, CodingKey {
        case format
        case version
        case keyID = "keyId"
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
    public let encrypted: Bool
    public let encryption: PageEncryptionDescriptor?

    public init(
        path: String,
        canonicalName: String,
        meta: PageMeta,
        body: String,
        revision: String,
        kind: String,
        inferred: Bool,
        project: String?,
        encrypted: Bool = false,
        encryption: PageEncryptionDescriptor? = nil
    ) {
        self.path = path
        self.canonicalName = canonicalName
        self.meta = meta
        self.body = body
        self.revision = revision
        self.kind = kind
        self.inferred = inferred
        self.project = project
        self.encrypted = encrypted
        self.encryption = encryption
    }

    private enum CodingKeys: String, CodingKey {
        case path
        case canonicalName
        case meta
        case body
        case revision
        case kind
        case inferred
        case project
        case encrypted
        case encryption
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        canonicalName = try container.decode(String.self, forKey: .canonicalName)
        meta = try container.decode(PageMeta.self, forKey: .meta)
        body = try container.decode(String.self, forKey: .body)
        revision = try container.decode(String.self, forKey: .revision)
        kind = try container.decode(String.self, forKey: .kind)
        inferred = try container.decode(Bool.self, forKey: .inferred)
        project = try container.decodeIfPresent(String.self, forKey: .project)
        encryption = try container.decodeIfPresent(PageEncryptionDescriptor.self, forKey: .encryption)
        encrypted = try container.decodeIfPresent(Bool.self, forKey: .encrypted) ?? (encryption != nil)
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
    public let tags: [String]?
    public let aliases: [String]?
    public let body: String?

    public init(
        expectedRevision: String,
        title: String?,
        tags: [String]? = nil,
        aliases: [String]? = nil,
        body: String?
    ) {
        self.expectedRevision = expectedRevision
        self.title = title
        self.tags = tags
        self.aliases = aliases
        self.body = body
    }
}
