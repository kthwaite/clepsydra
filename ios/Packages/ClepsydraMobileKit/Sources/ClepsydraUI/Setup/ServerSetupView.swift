import SwiftUI

public struct ServerSetupView: View {
    private let session: VaultSession

    public init(session: VaultSession) {
        self.session = session
    }

    public var body: some View {
        @Bindable var session = session

        Form {
            if session.isDiscovering || !session.discoveredServers.isEmpty {
                Section {
                    ForEach(session.discoveredServers, id: \.url) { server in
                        Button {
                            Task { await session.connect(to: server) }
                        } label: {
                            Text(server.url.absoluteString)
                                .font(.body.monospaced())
                        }
                        .disabled(!session.canEditAddress)
                    }

                    if session.isDiscovering {
                        HStack {
                            ProgressView()
                            Text("Looking for servers…")
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Available servers")
                } footer: {
                    // Set expectations: a sweep can only reach addresses we
                    // already have a reason to try, so an empty result on a
                    // phone is normal rather than a failure.
                    Text("Servers you have used before, plus a local development server.")
                }
            }

            Section {
                TextField("Server URL", text: $session.addressInput)
                    .disabled(!session.canEditAddress)
#if os(iOS)
                    .keyboardType(.URL)
#endif
#if os(iOS)
                    .textInputAutocapitalization(.never)
#endif
                    .autocorrectionDisabled(true)
#if os(iOS)
                    .textContentType(.URL)
#endif

                Button {
                    Task { await session.connect() }
                } label: {
                    HStack {
                        Text("Connect")
                        Spacer()
                        if session.isConnecting {
                            ProgressView()
                        }
                    }
                }
                .disabled(!session.canEditAddress)
            } footer: {
                if let errorMessage = session.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Connect to Clepsydra")
        .task {
            // Only sweep when there is nothing to connect to yet, so returning
            // to setup after a failure does not restart a scan mid-retry.
            if session.isDisconnected { await session.discover() }
        }
    }
}
