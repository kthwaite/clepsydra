import SwiftUI

public struct ServerSetupView: View {
    private let session: VaultSession

    public init(session: VaultSession) {
        self.session = session
    }

    public var body: some View {
        @Bindable var session = session

        Form {
            Section {
                TextField("Server URL", text: $session.addressInput)
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
                .disabled(session.isConnecting)
            } footer: {
                if let errorMessage = session.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Connect to Clepsydra")
    }
}
