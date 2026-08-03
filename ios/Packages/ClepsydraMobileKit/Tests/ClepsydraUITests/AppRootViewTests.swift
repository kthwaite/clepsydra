import ClepsydraCore
import ClepsydraUI
import XCTest

@MainActor
final class AppRootViewTests: XCTestCase {
    func testRootViewCanBeConstructed() {
        _ = AppRootView()
    }

    func testRootViewAcceptsOneInjectedSessionForSetupAndConnectedStates() {
        let session = VaultSession(addressStore: TestAddressStore(), apiFactory: { _ in TestAPI() })

        _ = AppRootView(session: session)
        _ = ServerSetupView(session: session)
    }
}

@MainActor
private final class TestAddressStore: ServerAddressStoring {
    var serverAddress: String?
    var recentAddresses: [String] = []
}

private final class TestAPI: VaultAPI, @unchecked Sendable {
    func uptime() async throws {}
    func search(query: String, limit: Int) async throws -> [SearchResult] { [] }
    func page(id: UUID) async throws -> PageDetail { fatalError("unused") }
    func createPage(_ request: CreatePageRequest) async throws -> PageDetail { fatalError("unused") }
    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail { fatalError("unused") }
}
