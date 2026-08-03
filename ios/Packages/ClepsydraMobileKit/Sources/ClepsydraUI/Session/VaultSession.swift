import ClepsydraCore
import Foundation
import Observation

public typealias VaultAPIFactory = @MainActor @Sendable (ServerURL) -> any VaultAPI

@MainActor @Observable
public final class VaultSession {
    public enum State {
        case disconnected
        case connecting
        case connected(any VaultAPI)
        case failed(String)
    }

    public private(set) var state: State = .disconnected
    public var addressInput: String

    private let apiFactory: VaultAPIFactory
    private let addressStore: any ServerAddressStoring

    public init(
        addressStore: any ServerAddressStoring = ServerAddressStore(),
        apiFactory: @escaping VaultAPIFactory = { server in APIClient(server: server) }
    ) {
        self.addressStore = addressStore
        self.apiFactory = apiFactory
        self.addressInput = addressStore.serverAddress ?? ""
    }

    public var api: (any VaultAPI)? {
        guard case let .connected(api) = state else { return nil }
        return api
    }

    public var isDisconnected: Bool {
        if case .disconnected = state { return true }
        return false
    }

    public var isConnecting: Bool {
        if case .connecting = state { return true }
        return false
    }

    public var isConnected: Bool {
        if case .connected = state { return true }
        return false
    }

    public var canRetry: Bool {
        if case .failed = state { return true }
        return false
    }

    public var errorMessage: String? {
        guard case let .failed(message) = state else { return nil }
        return message
    }

    public func connect() async {
        apiWillChange()

        let server: ServerURL
        do {
            server = try ServerURL(addressInput)
        } catch {
            state = .failed("Enter a valid HTTPS server address.")
            return
        }

        state = .connecting
        let api = apiFactory(server)
        do {
            try await api.uptime()
            addressStore.serverAddress = server.url.absoluteString
            state = .connected(api)
        } catch {
            state = .failed(Self.message(for: error))
        }
    }

    public func disconnect() {
        reset()
    }

    public func reset() {
        state = .disconnected
    }

    private func apiWillChange() {
        state = .disconnected
    }

    private static func message(for error: Error) -> String {
        if let error = error as? VaultAPIError {
            return error.userMessage
        }
        return "The Clepsydra server could not be reached. Try again."
    }
}
