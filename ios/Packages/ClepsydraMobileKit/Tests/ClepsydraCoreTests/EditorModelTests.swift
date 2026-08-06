import XCTest
@testable import ClepsydraCore

@MainActor
final class EditorModelTests: XCTestCase {
    func testCreateRejectsWhitespaceTitleWithoutCallingAPI() async {
        let api = EditorTestAPI()
        let model = EditorViewModel(mode: .create, api: api)
        model.title = "  \n"
        model.body = "# Draft"

        model.save()
        await waitUntil { model.phase == .failed("A title is required.") }

        XCTAssertEqual(api.createRequests.count, 0)
        XCTAssertEqual(model.body, "# Draft")
    }

    func testCreateTrimsTitleAndSendsExactMarkdownBody() async {
        let created = makePage(path: "notes/new.md", body: "# Exact\n\nMarkdown", revision: "r1")
        let api = EditorTestAPI(createResult: .success(created))
        let model = EditorViewModel(mode: .create, api: api)
        model.title = "  New note  "
        model.body = "# Exact\n\nMarkdown"

        model.save()
        await waitUntil { model.phase == .idle }

        XCTAssertEqual(api.createRequests, [CreatePageRequest(title: "New note", body: "# Exact\n\nMarkdown")])
        XCTAssertEqual(model.lastSavedPage, created)
    }

    func testSuccessfulCreateCallsCallbackWithReturnedPageIdentityAndRevision() async {
        let created = makePage(path: "notes/new.md", body: "Body", revision: "server-r1")
        let api = EditorTestAPI(createResult: .success(created))
        var callbackPage: PageDetail?
        let model = EditorViewModel(mode: .create, api: api) { callbackPage = $0 }
        model.title = "New"
        model.body = "Body"

        model.save()
        await waitUntil { callbackPage != nil }

        XCTAssertEqual(callbackPage?.id, created.id)
        XCTAssertEqual(callbackPage?.path, "notes/new.md")
        XCTAssertEqual(callbackPage?.revision, "server-r1")
    }

    func testCreateFailurePreservesDraftTitleAndBody() async {
        let api = EditorTestAPI(createResult: .failure(EditorTestError.failed))
        let model = EditorViewModel(mode: .create, api: api)
        model.title = "Draft title"
        model.body = "Draft body"

        model.save()
        await waitUntil { model.phase == .failed("editor failed") }

        XCTAssertEqual(model.title, "Draft title")
        XCTAssertEqual(model.body, "Draft body")
    }

    func testPreviewUsesCurrentBodyWithoutMakingAPIRequest() {
        let api = EditorTestAPI()
        let model = EditorViewModel(mode: .create, api: api)
        model.body = "*current* body"
        model.presentationMode = .preview

        XCTAssertEqual(model.previewMarkdown, "*current* body")
        XCTAssertEqual(api.createRequests.count, 0)
        XCTAssertEqual(api.updateRequests.count, 0)
    }

    func testUpdateSendsOriginalUUIDRevisionAndExactDraft() async {
        let pageID = UUID()
        let initial = makePage(id: pageID, path: "notes/old.md", title: "Old", body: "Old body", revision: "original-r1")
        let returned = makePage(id: pageID, path: "notes/new.md", title: "New", body: "New body", revision: "server-r2")
        let api = EditorTestAPI(updateResult: .success(returned))
        let model = EditorViewModel(mode: .edit(initial), api: api)
        model.title = "New"
        model.body = "New body"

        model.save()
        await waitUntil { model.phase == .idle }

        XCTAssertEqual(api.updateRequests.count, 1)
        XCTAssertEqual(api.updateRequests[0].id, pageID)
        XCTAssertEqual(api.updateRequests[0].request.expectedRevision, "original-r1")
        XCTAssertEqual(api.updateRequests[0].request.title, "New")
        XCTAssertEqual(api.updateRequests[0].request.body, "New body")
    }

    func testSuccessfulUpdateAdoptsReturnedPathBodyAndRevision() async {
        let pageID = UUID()
        let initial = makePage(id: pageID, path: "notes/old.md", title: "Old", body: "Old body", revision: "r1")
        let returned = makePage(id: pageID, path: "notes/new.md", title: "Server title", body: "Server body", revision: "r2")
        let api = EditorTestAPI(updateResult: .success(returned))
        let model = EditorViewModel(mode: .edit(initial), api: api)
        model.title = "Local title"
        model.body = "Local body"

        model.save()
        await waitUntil { model.lastSavedPage == returned }

        XCTAssertEqual(model.sourcePage, returned)
        XCTAssertEqual(model.title, "Server title")
        XCTAssertEqual(model.body, "Server body")
        XCTAssertEqual(model.revision, "r2")
        XCTAssertEqual(model.pageID, pageID)
    }

    func testRevisionConflictRetainsDraftAndExposesCurrentRevision() async {
        let pageID = UUID()
        let initial = makePage(id: pageID, path: "notes/conflict.md", title: "Initial", body: "Initial body", revision: "r1")
        let api = EditorTestAPI(updateResult: .failure(VaultAPIError.revisionConflict(currentRevision: "r2")))
        let model = EditorViewModel(mode: .edit(initial), api: api)
        model.title = "Draft title"
        model.body = "Draft body"

        model.save()
        await waitUntil { model.phase == .conflict(currentRevision: "r2") }

        XCTAssertEqual(model.title, "Draft title")
        XCTAssertEqual(model.body, "Draft body")
        XCTAssertEqual(model.revision, "r1")
        XCTAssertEqual(model.conflictRevision, "r2")
        XCTAssertEqual(api.updateRequests.count, 1)
    }

    func testKeepDraftDismissesConflictWithoutRequestOrContentLoss() async {
        let initial = makePage(path: "notes/conflict.md", title: "Initial", body: "Initial body", revision: "r1")
        let api = EditorTestAPI(updateResult: .failure(VaultAPIError.revisionConflict(currentRevision: "r2")))
        let model = EditorViewModel(mode: .edit(initial), api: api)
        model.title = "Keep this title"
        model.body = "Keep this body"
        model.save()
        await waitUntil { model.isInConflict }

        model.keepDraft()
        model.save()
        await Task.yield()

        XCTAssertEqual(model.title, "Keep this title")
        XCTAssertEqual(model.body, "Keep this body")
        XCTAssertEqual(api.updateRequests.count, 1)
        XCTAssertTrue(model.isInConflict)
        XCTAssertFalse(model.isConflictPresented)
    }

    func testReloadFetchesCurrentPageAndReplacesDraftWithoutUpdating() async {
        let pageID = UUID()
        let initial = makePage(id: pageID, path: "notes/conflict.md", title: "Initial", body: "Initial body", revision: "r1")
        let server = makePage(id: pageID, path: "notes/current.md", title: "Current", body: "Current body", revision: "r2")
        let api = EditorTestAPI(pageResult: .success(server))
        let model = EditorViewModel(mode: .edit(initial), api: api)
        model.title = "Discarded title"
        model.body = "Discarded body"

        model.reloadFromServer()
        await waitUntil { model.sourcePage == server }

        XCTAssertEqual(api.pageIDs, [pageID])
        XCTAssertEqual(api.updateRequests.count, 0)
        XCTAssertEqual(model.title, "Current")
        XCTAssertEqual(model.body, "Current body")
        XCTAssertEqual(model.revision, "r2")
    }

    func testConflictDoesNotAutomaticallyRetryOrForceSave() async {
        let initial = makePage(path: "notes/conflict.md", body: "Body", revision: "r1")
        let api = EditorTestAPI(updateResult: .failure(VaultAPIError.revisionConflict(currentRevision: "r2")))
        let model = EditorViewModel(mode: .edit(initial), api: api)
        model.body = "Draft"

        model.save()
        await waitUntil { model.isInConflict }
        model.retry()
        await Task.yield()

        XCTAssertEqual(api.updateRequests.count, 1)
        XCTAssertEqual(model.revision, "r1")
        XCTAssertEqual(model.body, "Draft")
    }

    func testNotFoundPreservesDraftAndReportsDeletion() async {
        let initial = makePage(path: "notes/deleted.md", title: "Initial", body: "Initial body", revision: "r1")
        let api = EditorTestAPI(updateResult: .failure(VaultAPIError.server(status: 404, message: "gone")))
        let model = EditorViewModel(mode: .edit(initial), api: api)
        model.title = "Draft title"
        model.body = "Draft body"

        model.save()
        await waitUntil { model.phase == .deleted }

        XCTAssertEqual(model.title, "Draft title")
        XCTAssertEqual(model.body, "Draft body")
        XCTAssertEqual(model.errorMessage, "This page was deleted on the server.")
    }

    func testRetryOnlyRetriesFailedSaveAndCancelSignalsDismissal() async {
        let api = EditorTestAPI(createResult: .failure(EditorTestError.failed))
        var cancelled = false
        let model = EditorViewModel(mode: .create, api: api, onCancel: { cancelled = true })
        model.title = "Draft"
        model.body = "Body"
        model.save()
        await waitUntil { model.phase == .failed("editor failed") }

        api.createResult = .success(makePage(path: "notes/retry.md", body: "Body", revision: "r2"))
        model.retry()
        await waitUntil { model.lastSavedPage != nil }
        model.cancel()

        XCTAssertEqual(api.createRequests.count, 2)
        XCTAssertTrue(cancelled)
    }

    private func makePage(
        id: UUID = UUID(),
        path: String,
        title: String? = nil,
        body: String,
        revision: String
    ) -> PageDetail {
        PageDetail(
            path: path,
            canonicalName: path,
            meta: PageMeta(id: id, title: title, tags: [], aliases: [], createdAt: nil, updatedAt: nil),
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
        XCTFail("Timed out waiting for editor state")
    }
}

private enum EditorTestError: LocalizedError, Equatable {
    case failed

    var errorDescription: String? { "editor failed" }
}

private final class EditorTestAPI: VaultAPI, @unchecked Sendable {
    struct UpdateCall: Equatable {
        let id: UUID
        let request: UpdatePageRequest
    }

    var pageResult: Result<PageDetail, Error> = .failure(EditorTestError.failed)
    var createResult: Result<PageDetail, Error> = .failure(EditorTestError.failed)
    var updateResult: Result<PageDetail, Error> = .failure(EditorTestError.failed)
    var pageIDs: [UUID] = []
    var createRequests: [CreatePageRequest] = []
    var updateRequests: [UpdateCall] = []
    
    init(
        pageResult: Result<PageDetail, Error> = .failure(EditorTestError.failed),
        createResult: Result<PageDetail, Error> = .failure(EditorTestError.failed),
        updateResult: Result<PageDetail, Error> = .failure(EditorTestError.failed)
    ) {
        self.pageResult = pageResult
        self.createResult = createResult
        self.updateResult = updateResult
    }

    func uptime() async throws {}
    func search(query: String, limit: Int) async throws -> [SearchResult] { [] }

    func page(id: UUID) async throws -> PageDetail {
        pageIDs.append(id)
        return try pageResult.get()
    }

    func createPage(_ request: CreatePageRequest) async throws -> PageDetail {
        createRequests.append(request)
        return try createResult.get()
    }

    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail {
        updateRequests.append(UpdateCall(id: id, request: request))
        return try updateResult.get()
    }
}
