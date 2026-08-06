import Foundation
import Observation

@MainActor @Observable
public final class EditorViewModel {
    public enum Mode: Equatable, Sendable {
        case create
        case edit(PageDetail)
    }

    public enum PresentationMode: String, CaseIterable, Sendable {
        case edit
        case preview
    }

    public enum Phase: Equatable, Sendable {
        case idle
        case saving
        case reloading
        case failed(String)
        case conflict(currentRevision: String)
        case deleted
    }

    private enum RetryAction {
        case save
        case reload
    }

    public let mode: Mode
    public private(set) var sourcePage: PageDetail?
    public private(set) var phase: Phase = .idle
    public private(set) var lastSavedPage: PageDetail?
    public private(set) var conflictRevision: String?
    public private(set) var isConflictPresented = false
    public private(set) var didCancel = false

    public var title: String
    public var body: String
    public var presentationMode: PresentationMode = .edit

    private let api: any VaultAPI
    private let onSaved: ((PageDetail) -> Void)?
    private let onCancel: (() -> Void)?
    private var operationTask: Task<Void, Never>?
    private var operationGeneration = 0
    private var retryAction: RetryAction = .save

    public init(
        mode: Mode,
        api: any VaultAPI,
        onSaved: ((PageDetail) -> Void)? = nil,
        onCancel: (() -> Void)? = nil
    ) {
        self.mode = mode
        self.api = api
        self.onSaved = onSaved
        self.onCancel = onCancel

        switch mode {
        case .create:
            sourcePage = nil
            title = ""
            body = ""
        case let .edit(page):
            sourcePage = page
            title = Self.title(for: page)
            body = page.body
        }
    }

    public convenience init(
        page: PageDetail,
        api: any VaultAPI,
        onSaved: ((PageDetail) -> Void)? = nil,
        onCancel: (() -> Void)? = nil
    ) {
        self.init(mode: .edit(page), api: api, onSaved: onSaved, onCancel: onCancel)
    }

    public var state: Phase { phase }

    public var pageID: UUID? { sourcePage?.id }

    public var revision: String? { sourcePage?.revision }

    public var initialPage: PageDetail? { sourcePage }

    public var isSaving: Bool {
        if case .saving = phase { return true }
        if case .reloading = phase { return true }
        return false
    }

    public var isInConflict: Bool {
        if case .conflict = phase { return true }
        return false
    }

    public var canSave: Bool {
        !isSaving && !isInConflict && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var isDirty: Bool {
        guard let sourcePage else {
            return !title.isEmpty || !body.isEmpty
        }
        return title != Self.title(for: sourcePage) || body != sourcePage.body
    }

    public var errorMessage: String? {
        switch phase {
        case let .failed(message): return message
        case .deleted: return "This page was deleted on the server."
        case .conflict: return VaultAPIError.revisionConflict(currentRevision: conflictRevision ?? "").userMessage
        case .idle, .saving, .reloading: return nil
        }
    }

    public var previewMarkdown: String { body }

    public var editorMode: PresentationMode {
        get { presentationMode }
        set { presentationMode = newValue }
    }

    public func save() {
        guard !isSaving, !isInConflict else { return }

        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            retryAction = .save
            phase = .failed("A title is required.")
            return
        }

        operationTask?.cancel()
        operationGeneration += 1
        let generation = operationGeneration
        let api = api
        let body = body
        let sourcePage = sourcePage
        retryAction = .save
        conflictRevision = nil
        isConflictPresented = false
        phase = .saving

        operationTask = Task { [weak self] in
            do {
                let savedPage: PageDetail
                if let sourcePage {
                    let request = UpdatePageRequest(
                        expectedRevision: sourcePage.revision,
                        title: trimmedTitle,
                        body: body
                    )
                    savedPage = try await api.updatePage(id: sourcePage.id, request: request)
                } else {
                    savedPage = try await api.createPage(CreatePageRequest(title: trimmedTitle, body: body))
                }

                guard !Task.isCancelled else { return }
                guard let self, self.operationGeneration == generation else { return }
                self.sourcePage = savedPage
                self.lastSavedPage = savedPage
                self.title = Self.title(for: savedPage)
                self.body = savedPage.body
                self.conflictRevision = nil
                self.isConflictPresented = false
                self.phase = .idle
                self.onSaved?(savedPage)
            } catch {
                guard !Task.isCancelled else { return }
                guard let self, self.operationGeneration == generation else { return }
                self.applyFailure(error)
            }
        }
    }

    public func retry() {
        guard !isSaving, !isInConflict, phase != .deleted else { return }
        switch retryAction {
        case .save:
            save()
        case .reload:
            reloadFromServer()
        }
    }

    public func reloadFromServer() {
        guard !isSaving, let pageID else { return }
        operationTask?.cancel()
        operationGeneration += 1
        let generation = operationGeneration
        let api = api
        retryAction = .reload
        conflictRevision = nil
        isConflictPresented = false
        phase = .reloading

        operationTask = Task { [weak self] in
            do {
                let currentPage = try await api.page(id: pageID)
                guard !Task.isCancelled else { return }
                guard let self, self.operationGeneration == generation else { return }
                self.sourcePage = currentPage
                self.title = Self.title(for: currentPage)
                self.body = currentPage.body
                self.phase = .idle
            } catch {
                guard !Task.isCancelled else { return }
                guard let self, self.operationGeneration == generation else { return }
                self.applyFailure(error)
            }
        }
    }

    public func keepDraft() {
        guard isInConflict else { return }
        isConflictPresented = false
    }

    public func cancel() {
        operationTask?.cancel()
        operationTask = nil
        operationGeneration += 1
        didCancel = true
        onCancel?()
    }

    private func applyFailure(_ error: Error) {
        if let vaultError = error as? VaultAPIError {
            switch vaultError {
            case let .revisionConflict(currentRevision):
                conflictRevision = currentRevision
                isConflictPresented = true
                phase = .conflict(currentRevision: currentRevision)
            case let .server(status, _):
                phase = status == 404 ? .deleted : .failed(vaultError.userMessage)
            default:
                phase = .failed(vaultError.userMessage)
            }
        } else {
            phase = .failed(error.localizedDescription)
        }
    }

    private static func title(for page: PageDetail) -> String {
        page.meta.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? page.meta.title!.trimmingCharacters(in: .whitespacesAndNewlines)
            : page.canonicalName
    }
}

public typealias EditorModel = EditorViewModel
