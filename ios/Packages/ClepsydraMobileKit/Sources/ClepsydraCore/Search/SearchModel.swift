import Foundation
import Observation

public typealias SearchSleeper = @Sendable (Duration) async -> Void

@MainActor @Observable
public final class SearchViewModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded([SearchResult])
        case failed(String)
    }

    public private(set) var query = ""
    public private(set) var phase: Phase = .idle

    public var state: Phase {
        phase
    }

    private let api: any VaultAPI
    private let sleeper: SearchSleeper
    private var searchTask: Task<Void, Never>?
    private var requestGeneration = 0

    public init(
        api: any VaultAPI,
        sleeper: @escaping SearchSleeper = { duration in
            do {
                try await Task.sleep(for: duration)
            } catch {
                // Cancellation is observed by the task immediately after sleeping.
            }
        }
    ) {
        self.api = api
        self.sleeper = sleeper
    }
    public convenience init(api: any VaultAPI, sleep: @escaping SearchSleeper) {
        self.init(api: api, sleeper: sleep)
    }

    public var results: [SearchResult] {
        guard case let .loaded(results) = phase else { return [] }
        return results
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
        guard case .failed = phase else { return false }
        return !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func updateQuery(_ query: String) {
        self.query = query
        requestGeneration += 1
        let generation = requestGeneration
        searchTask?.cancel()
        searchTask = nil

        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            phase = .idle
            return
        }

        phase = .loading
        let api = self.api
        let sleeper = self.sleeper
        searchTask = Task { [weak self] in
            await sleeper(.milliseconds(250))
            guard !Task.isCancelled else { return }

            do {
                let results = try await api.search(query: query, limit: 20)
                guard !Task.isCancelled else { return }
                guard let self, self.requestGeneration == generation else { return }
                self.phase = .loaded(results)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                guard let self, self.requestGeneration == generation else { return }
                self.phase = .failed(Self.message(for: error))
            }
        }
    }

    public func retry() {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            phase = .idle
            return
        }
        startImmediateSearch()
    }

    private func startImmediateSearch() {
        requestGeneration += 1
        let generation = requestGeneration
        let query = self.query
        searchTask?.cancel()
        phase = .loading
        let api = self.api
        searchTask = Task { [weak self] in
            do {
                let results = try await api.search(query: query, limit: 20)
                guard !Task.isCancelled else { return }
                guard let self, self.requestGeneration == generation else { return }
                self.phase = .loaded(results)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                guard let self, self.requestGeneration == generation else { return }
                self.phase = .failed(Self.message(for: error))
            }
        }
    }

    private static func message(for error: Error) -> String {
        if let error = error as? VaultAPIError {
            return error.userMessage
        }
        return "Search failed. Try again."
    }
}

public typealias SearchModel = SearchViewModel
