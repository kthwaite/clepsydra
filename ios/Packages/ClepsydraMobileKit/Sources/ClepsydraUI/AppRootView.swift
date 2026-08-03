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
                ConnectedVaultView(session: session)
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

private struct ConnectedVaultView: View {
    let session: VaultSession
    @State private var query = ""

    var body: some View {
        VStack(spacing: 24) {
            TextField("Search your vault", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("vault-search-field")

            ContentUnavailableView(
                "Search your vault",
                systemImage: "magnifyingglass",
                description: Text("Enter a search term to find pages.")
            )

            Button("Disconnect", role: .destructive) {
                session.disconnect()
            }
        }
        .padding()
        .navigationTitle("Clepsydra")
    }
}
