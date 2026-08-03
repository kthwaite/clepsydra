import Foundation
import Observation

@MainActor @Observable
public final class ReaderViewModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded(PageDetail)
        case failed(String)
    }

    public let pageID: UUID
    public private(set) var phase: Phase = .idle

    private let api: any VaultAPI
    private var loadTask: Task<Void, Never>?
    private var requestGeneration = 0

    public init(pageID: UUID, api: any VaultAPI) {
        self.pageID = pageID
        self.api = api
    }

    public var state: Phase {
        phase
    }

    public var page: PageDetail? {
        guard case let .loaded(page) = phase else { return nil }
        return page
    }

    public var isLoading: Bool {
        if case .loading = phase { return true }
        return false
    }

    public var errorMessage: String? {
        guard case let .failed(message) = phase else { return nil }
        return message
    }

    public var canRetry: Bool {
        if case .failed = phase { return true }
        return false
    }

    public func load() {
        guard !isLoading else { return }

        requestGeneration += 1
        let generation = requestGeneration
        let api = api
        let pageID = pageID
        phase = .loading

        loadTask = Task { [weak self] in
            do {
                let page = try await api.page(id: pageID)
                guard !Task.isCancelled else { return }
                guard let self, self.requestGeneration == generation else { return }
                self.phase = .loaded(page)
            } catch {
                guard !Task.isCancelled else { return }
                guard let self, self.requestGeneration == generation else { return }
                self.phase = .failed(error.localizedDescription)
            }
        }
    }

    public func retry() {
        guard canRetry else { return }
        load()
    }

    public func accept(_ page: PageDetail) {
        guard page.id == pageID else { return }
        loadTask?.cancel()
        loadTask = nil
        requestGeneration += 1
        phase = .loaded(page)
    }
}

public typealias ReaderModel = ReaderViewModel
