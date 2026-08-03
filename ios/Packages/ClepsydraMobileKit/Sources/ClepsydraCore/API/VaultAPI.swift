import Foundation

public protocol VaultAPI: Sendable {
    func uptime() async throws
    func search(query: String, limit: Int) async throws -> [SearchResult]
    func page(id: UUID) async throws -> PageDetail
    func createPage(_ request: CreatePageRequest) async throws -> PageDetail
    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail
}
