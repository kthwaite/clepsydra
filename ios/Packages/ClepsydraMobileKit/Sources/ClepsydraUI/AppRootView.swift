import SwiftUI

public struct AppRootView: View {
    @State private var session: VaultSession

    @MainActor
    public init(session: VaultSession? = nil) {
        _session = State(initialValue: session ?? VaultSession())
    }

    public var body: some View {
        Group {
            if session.isConnected {
                ConnectedVaultPlaceholder()
            } else {
                ServerSetupView(session: session)
            }
        }
        .task {
            guard session.isDisconnected, !session.addressInput.isEmpty else { return }
            await session.connect()
        }
    }
}

private struct ConnectedVaultPlaceholder: View {
    var body: some View {
        Text("Connected to Clepsydra")
    }
}
