import XCTest
@testable import ClepsydraCore

@MainActor
final class ReaderModelTests: XCTestCase {
    func testStartsIdleAndLoadsPageByInjectedUUID() async {
        let pageID = UUID()
        let page = makePage(id: pageID, path: "notes/first.md", body: "# First", revision: "r1")
        let api = ControlledReaderAPI(result: .success(page))
        let model = ReaderViewModel(pageID: pageID, api: api)

        XCTAssertEqual(model.pageID, pageID)
        XCTAssertEqual(model.phase, .idle)

        model.load()
        await api.waitForPageRequest()
        api.complete()
        await waitUntil { model.phase == .loaded(page) }

        XCTAssertEqual(model.page, page)
        XCTAssertEqual(model.page?.path, "notes/first.md")
        XCTAssertEqual(model.page?.body, "# First")
        XCTAssertEqual(model.page?.revision, "r1")
    }

    func testFailureExposesErrorAndRetryLoadsAgain() async {
        let pageID = UUID()
        let page = makePage(id: pageID, path: "notes/retry.md", body: "Retry", revision: "r2")
        let api = ControlledReaderAPI(result: .failure(TestError.failed))
        let model = ReaderModel(pageID: pageID, api: api)

        model.load()
        await api.waitForPageRequest()
        api.complete()
        await waitUntil { model.phase == .failed(TestError.failed.localizedDescription) }
        XCTAssertTrue(model.canRetry)

        api.result = .success(page)
        model.retry()
        await api.waitForPageRequest(occurrence: 2)
        api.complete()
        await waitUntil { model.phase == .loaded(page) }
        XCTAssertEqual(model.page?.revision, "r2")
    }

    func testAcceptReplacesEntireLoadedPageButKeepsIdentityFixed() async {
        let pageID = UUID()
        let initial = makePage(id: pageID, path: "notes/old.md", body: "Old", revision: "r1")
        let updated = makePage(id: pageID, path: "notes/new.md", body: "New", revision: "r2")
        let api = ControlledReaderAPI(result: .success(initial))
        let model = ReaderModel(pageID: pageID, api: api)

        model.accept(initial)
        model.accept(updated)

        XCTAssertEqual(model.pageID, pageID)
        XCTAssertEqual(model.page, updated)
        XCTAssertEqual(model.page?.path, "notes/new.md")
        XCTAssertEqual(model.page?.body, "New")
        XCTAssertEqual(model.page?.revision, "r2")
    }

    func testAcceptIgnoresPageWithDifferentIdentity() {
        let pageID = UUID()
        let other = makePage(id: UUID(), path: "other.md", body: "Other", revision: "other")
        let model = ReaderModel(pageID: pageID, api: ControlledReaderAPI(result: .failure(TestError.failed)))

        model.accept(other)

        XCTAssertNil(model.page)
        XCTAssertEqual(model.phase, .idle)
    }

    private func makePage(id: UUID, path: String, body: String, revision: String) -> PageDetail {
        PageDetail(
            path: path,
            canonicalName: path,
            meta: PageMeta(id: id, title: nil, tags: [], aliases: [], createdAt: nil, updatedAt: nil),
            body: body,
            revision: revision,
            kind: "markdown",
            inferred: false,
            project: nil
        )
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () -> Bool
    ) async {
        for _ in 0..<100 {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for reader state")
    }
}

private enum TestError: LocalizedError {
    case failed

    var errorDescription: String? { "reader failed" }
}

private final class ControlledReaderAPI: VaultAPI, @unchecked Sendable {
    enum Result {
        case success(PageDetail)
        case failure(Error)
    }

    var result: Result
    private var requestCount = 0
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []
    private var resultWaiters: [CheckedContinuation<Result, Never>] = []

    init(result: Result) {
        self.result = result
    }

    func uptime() async throws {}
    func search(query: String, limit: Int) async throws -> [SearchResult] { [] }

    func page(id: UUID) async throws -> PageDetail {
        requestCount += 1
        requestWaiters.forEach { $0.resume() }
        requestWaiters.removeAll()
        let result = await withCheckedContinuation { continuation in
            resultWaiters.append(continuation)
        }
        switch result {
        case let .success(page): return page
        case let .failure(error): throw error
        }
    }

    func createPage(_ request: CreatePageRequest) async throws -> PageDetail { fatalError("unused") }
    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail { fatalError("unused") }

    func waitForPageRequest(occurrence: Int = 1) async {
        while requestCount < occurrence {
            await withCheckedContinuation { continuation in
                requestWaiters.append(continuation)
            }
        }
    }

    func complete() {
        let result = result
        resultWaiters.removeFirst().resume(returning: result)
    }
}
