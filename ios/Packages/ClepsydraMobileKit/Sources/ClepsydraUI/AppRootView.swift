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
    @State private var selectedPageID: UUID?
    @State private var showingNewNote = false

    var body: some View {
        NavigationStack {
            Group {
                if let api = session.api {
                    SearchView(
                        query: $query,
                        api: api,
                        openPage: { selectedPageID = $0 },
                        createPage: { showingNewNote = true }
                    )
                } else {
                    ContentUnavailableView(
                        "Vault disconnected",
                        systemImage: "wifi.slash",
                        description: Text("Reconnect to search your vault.")
                    )
                }
            }
            .navigationDestination(item: $selectedPageID) { pageID in
                ReaderPlaceholderView(session: session, pageID: pageID)
            }
        }
        .navigationTitle("Clepsydra")
        .sheet(isPresented: $showingNewNote) {
            NewNotePlaceholder()
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Disconnect", role: .destructive) {
                    session.disconnect()
                }
            }
        }
    }
}

private struct ReaderPlaceholderView: View {
    let session: VaultSession
    let pageID: UUID
    @State private var loaded = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let errorMessage {
                ContentUnavailableView(
                    "Unable to open page",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if loaded {
                ContentUnavailableView(
                    "Reader placeholder",
                    systemImage: "doc.text",
                    description: Text("Page \(pageID.uuidString)")
                )
            } else {
                ProgressView("Opening page…")
            }
        }
        .navigationTitle("Reader")
        .task {
            do {
                guard let api = session.api else { return }
                _ = try await api.page(id: pageID)
                loaded = true
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct NewNotePlaceholder: View {
    var body: some View {
        ContentUnavailableView(
            "New note",
            systemImage: "square.and.pencil",
            description: Text("Note creation will be available here.")
        )
        .presentationDetents([.medium])
    }
}
