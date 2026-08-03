import ClepsydraCore
import XCTest
@testable import ClepsydraUI

@MainActor
final class VaultSessionTests: XCTestCase {
    func testValidSavedURLStartsConnectionCheck() async {
        let store = InMemoryServerAddressStore(address: " https://saved.example/ ")
        let api = StubVaultAPI()
        let factory = FactoryRecorder(api: api)
        let session = VaultSession(addressStore: store, apiFactory: factory.make)

        XCTAssertEqual(session.addressInput, " https://saved.example/ ")
        await session.connect()

        XCTAssertEqual(factory.makeCount, 1)
        XCTAssertEqual(api.uptimeCallCount, 1)
        XCTAssertTrue(session.isConnected)
    }

    func testSuccessfulUptimePersistsNormalizedURLAndConnects() async {
        let store = InMemoryServerAddressStore()
        let api = StubVaultAPI()
        let session = VaultSession(addressStore: store, apiFactory: { _ in api })
        session.addressInput = "  HTTPS://vault.example/  "

        await session.connect()

        XCTAssertEqual(store.serverAddress, "https://vault.example")
        XCTAssertTrue(session.isConnected)
    }

    func testFailedUptimeDoesNotPersistAndRetainsValueForRetry() async {
        let store = InMemoryServerAddressStore(address: "https://old.example")
        let api = StubVaultAPI(error: .unreachable)
        let session = VaultSession(addressStore: store, apiFactory: { _ in api })
        session.addressInput = " https://new.example/ "

        await session.connect()

        XCTAssertEqual(store.serverAddress, "https://old.example")
        XCTAssertEqual(session.addressInput, " https://new.example/ ")
        XCTAssertEqual(session.errorMessage, VaultAPIError.unreachable.userMessage)
        XCTAssertTrue(session.canRetry)
    }

    func testTransportFailuresHaveDistinctRetryableMessages() async {
        let errors: [VaultAPIError] = [.unreachable, .tls, .timedOut]
        var messages = Set<String>()
        for error in errors {
            let session = VaultSession(addressStore: InMemoryServerAddressStore(), apiFactory: { _ in StubVaultAPI(error: error) })
            session.addressInput = "https://vault.example"
            await session.connect()
            XCTAssertTrue(session.canRetry)
            messages.insert(session.errorMessage ?? "")
        }
        XCTAssertEqual(messages.count, errors.count)
    }

    func testMalformedAddressNeverCallsFactory() async {
        let factory = FactoryRecorder(api: StubVaultAPI())
        let session = VaultSession(addressStore: InMemoryServerAddressStore(), apiFactory: factory.make)

        for address in ["http://vault.example", "not a URL"] {
            session.addressInput = address
            await session.connect()
        }

        XCTAssertEqual(factory.makeCount, 0)
        XCTAssertTrue(session.errorMessage?.contains("HTTPS") == true)
    }

    func testChangingServersClearsCurrentAPIBeforeReconnect() async {
        let first = StubVaultAPI()
        let second = StubVaultAPI()
        let factory = SequenceFactory(apis: [first, second])
        let session = VaultSession(addressStore: InMemoryServerAddressStore(), apiFactory: factory.make)
        session.addressInput = "https://first.example"
        await session.connect()
        XCTAssertNotNil(session.api)

        session.addressInput = "https://second.example"
        await session.connect()

        XCTAssertEqual(factory.makeCount, 2)
        XCTAssertTrue(session.isConnected)
        XCTAssertNotNil(session.api)
    }

    func testDisconnectClearsAPIButRetainsSavedAddress() async {
        let store = InMemoryServerAddressStore()
        let session = VaultSession(addressStore: store, apiFactory: { _ in StubVaultAPI() })
        session.addressInput = "https://vault.example"
        await session.connect()
        session.disconnect()

        XCTAssertNil(session.api)
        XCTAssertEqual(store.serverAddress, "https://vault.example")
        XCTAssertTrue(session.isDisconnected)
    }
    func testResetClearsConnectionWithoutRemovingSavedAddress() async {
        let store = InMemoryServerAddressStore()
        let session = VaultSession(addressStore: store, apiFactory: { _ in StubVaultAPI() })
        session.addressInput = "https://vault.example"
        await session.connect()

        session.reset()

        XCTAssertTrue(session.isDisconnected)
        XCTAssertNil(session.api)
        XCTAssertEqual(store.serverAddress, "https://vault.example")
    }

    func testAddressInputCannotChangeDuringConnection() async {
        let api = BlockingVaultAPI()
        let session = VaultSession(addressStore: InMemoryServerAddressStore(), apiFactory: { _ in api })
        session.addressInput = "https://vault.example"

        let connection = Task { await session.connect() }
        while !api.isWaiting {
            await Task.yield()
        }

        XCTAssertTrue(session.isConnecting)
        XCTAssertFalse(session.canEditAddress)
        api.resume()
        await connection.value
        XCTAssertTrue(session.isConnected)
    }

    func testUserDefaultsStoreReadsAndRemovesOneKey() {
        let suiteName = "VaultSessionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let store = ServerAddressStore(defaults: defaults, key: "server")

        store.serverAddress = "https://vault.example"
        XCTAssertEqual(defaults.string(forKey: "server"), "https://vault.example")
        XCTAssertEqual(store.serverAddress, "https://vault.example")

        store.serverAddress = nil
        XCTAssertNil(defaults.object(forKey: "server"))
        defaults.removePersistentDomain(forName: suiteName)
    }
}

@MainActor
private final class InMemoryServerAddressStore: ServerAddressStoring {
    var serverAddress: String?

    init(address: String? = nil) {
        self.serverAddress = address
    }
}

private final class FactoryRecorder: @unchecked Sendable {
    let api: any VaultAPI
    var makeCount = 0

    init(api: any VaultAPI) {
        self.api = api
    }

    @MainActor
    func make(_ server: ServerURL) -> any VaultAPI {
        makeCount += 1
        return api
    }
}

private final class SequenceFactory: @unchecked Sendable {
    let apis: [any VaultAPI]
    var makeCount = 0

    init(apis: [any VaultAPI]) {
        self.apis = apis
    }

    @MainActor
    func make(_ server: ServerURL) -> any VaultAPI {
        defer { makeCount += 1 }
        return apis[min(makeCount, apis.count - 1)]
    }
}

private final class StubVaultAPI: VaultAPI, @unchecked Sendable {
    let error: VaultAPIError?
    var uptimeCallCount = 0

    init(error: VaultAPIError? = nil) {
        self.error = error
    }

    func uptime() async throws {
        uptimeCallCount += 1
        if let error { throw error }
    }

    func search(query: String, limit: Int) async throws -> [SearchResult] { [] }
    func page(id: UUID) async throws -> PageDetail { fatalError("unused") }
    func createPage(_ request: CreatePageRequest) async throws -> PageDetail { fatalError("unused") }
    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail { fatalError("unused") }
}
private final class BlockingVaultAPI: VaultAPI, @unchecked Sendable {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var isWaiting = false

    func uptime() async throws {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            self.continuation = continuation
            self.isWaiting = true
        }
    }

    func resume() {
        continuation?.resume()
        continuation = nil
        isWaiting = false
    }

    func search(query: String, limit: Int) async throws -> [SearchResult] { [] }
    func page(id: UUID) async throws -> PageDetail { fatalError("unused") }
    func createPage(_ request: CreatePageRequest) async throws -> PageDetail { fatalError("unused") }
    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail { fatalError("unused") }
}
