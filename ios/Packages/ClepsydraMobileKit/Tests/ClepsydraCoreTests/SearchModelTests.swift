import XCTest
@testable import ClepsydraCore

@MainActor
final class SearchModelTests: XCTestCase {
    func testDebouncesQueriesAndIgnoresStaleResults() async {
        let sleeper = ControlledSleeper()
        let api = ControlledVaultAPI()
        let model = SearchModel(api: api) { duration in
            await sleeper.sleep(duration)
        }

        model.updateQuery("first")
        await sleeper.waitForSleep()
        await sleeper.advance()
        await api.waitForRequest("first")

        model.updateQuery("second")
        await sleeper.waitForSleep()
        await sleeper.advance()
        await api.waitForRequest("second")

        let secondResult = makeResult(path: "second.md")
        await api.complete("second", with: [secondResult])
        await waitUntil { model.phase == .loaded([secondResult]) }

        let firstResult = makeResult(path: "first.md")
        await api.complete("first", with: [firstResult])
        await Task.yield()

        XCTAssertEqual(model.query, "second")
        XCTAssertEqual(model.phase, .loaded([secondResult]))
        let queriesAfterStaleCompletion = await api.queries
        XCTAssertEqual(queriesAfterStaleCompletion, ["first", "second"])
    }

    func testWhitespaceQueryReturnsToIdleWithoutCallingAPI() async {
        let sleeper = ControlledSleeper()
        let api = ControlledVaultAPI()
        let model = SearchModel(api: api) { duration in
            await sleeper.sleep(duration)
        }

        model.updateQuery("   \n")
        await Task.yield()

        XCTAssertEqual(model.phase, .idle)
        let queries = await api.queries
        XCTAssertTrue(queries.isEmpty)
        let pendingSleepCount = await sleeper.pendingCount
        XCTAssertEqual(pendingSleepCount, 0)
    }

    func testFailurePreservesQueryAndRetryRepeatsImmediately() async {
        let sleeper = ControlledSleeper()
        let api = ControlledVaultAPI()
        let model = SearchModel(api: api) { duration in
            await sleeper.sleep(duration)
        }

        model.updateQuery("failure")
        await sleeper.waitForSleep()
        await sleeper.advance()
        await api.waitForRequest("failure")
        await api.fail("failure", with: TestError.failed)
        await waitUntil { model.phase == .failed("Search failed. Try again.") }

        XCTAssertEqual(model.query, "failure")
        XCTAssertTrue(model.canRetry)

        model.retry()
        await api.waitForRequest("failure", occurrence: 2)
        let queriesAfterRetry = await api.queries
        XCTAssertEqual(queriesAfterRetry, ["failure", "failure"])
    }

    func testResultsExposeEmptyLoadedPhase() async {
        let sleeper = ControlledSleeper()
        let api = ControlledVaultAPI()
        let model = SearchModel(api: api) { duration in
            await sleeper.sleep(duration)
        }

        model.updateQuery("none")
        await sleeper.waitForSleep()
        await sleeper.advance()
        await api.waitForRequest("none")
        await api.complete("none", with: [])

        await waitUntil { model.phase == .loaded([]) }
        XCTAssertEqual(model.results, [])
    }

    private func makeResult(path: String) -> SearchResult {
        SearchResult(pageID: UUID(), path: path, title: nil, snippet: "snippet")
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () -> Bool
    ) async {
        for _ in 0..<100 where !condition() {
            await Task.yield()
        }
        XCTAssertTrue(condition())
    }
}

private enum TestError: Error {
    case failed
}

private actor ControlledSleeper {
    private var continuations: [CheckedContinuation<Void, Never>] = []

    var pendingCount: Int { continuations.count }

    func sleep(_ duration: Duration) async {
        await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func waitForSleep() async {
        for _ in 0..<100 where continuations.isEmpty {
            await Task.yield()
        }
        XCTAssertEqual(continuations.count, 1)
    }

    func advance() {
        guard !continuations.isEmpty else { return }
        continuations.removeFirst().resume()
    }
}

private actor ControlledVaultAPI: VaultAPI {
    var queries: [String] = []
    private var pending: [String: CheckedContinuation<[SearchResult], Error>] = [:]

    func uptime() async throws {}

    func search(query: String, limit: Int) async throws -> [SearchResult] {
        queries.append(query)
        return try await withCheckedThrowingContinuation { continuation in
            pending[query] = continuation
        }
    }

    func page(id: UUID) async throws -> PageDetail { fatalError("unused") }
    func createPage(_ request: CreatePageRequest) async throws -> PageDetail { fatalError("unused") }
    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail { fatalError("unused") }

    func waitForRequest(_ query: String, occurrence: Int = 1) async {
        for _ in 0..<100 where queries.filter({ $0 == query }).count < occurrence {
            await Task.yield()
        }
        XCTAssertEqual(queries.filter({ $0 == query }).count, occurrence)
    }

    func complete(_ query: String, with results: [SearchResult]) {
        pending.removeValue(forKey: query)?.resume(returning: results)
    }

    func fail(_ query: String, with error: Error) {
        pending.removeValue(forKey: query)?.resume(throwing: error)
    }
}
