import Foundation

public struct SearchResult: Codable, Equatable, Sendable, Identifiable {
    public var id: UUID { pageID }
    public let pageID: UUID
    public let path: String
    public let title: String?
    public let snippet: String

    public init(pageID: UUID, path: String, title: String?, snippet: String) {
        self.pageID = pageID
        self.path = path
        self.title = title
        self.snippet = snippet
    }

    private enum CodingKeys: String, CodingKey {
        case pageID = "pageId"
        case path
        case title
        case snippet
    }
}
