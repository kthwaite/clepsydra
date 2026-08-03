import ClepsydraCore
import SwiftUI

@MainActor
public struct NoteReaderView: View {
    private let pageID: UUID
    private let api: any VaultAPI
    @State private var model: ReaderViewModel
    @State private var showingEditor = false

    public init(pageID: UUID, api: any VaultAPI) {
        self.pageID = pageID
        self.api = api
        _model = State(initialValue: ReaderViewModel(pageID: pageID, api: api))
    }

    public var body: some View {
        content
            .navigationTitle(navigationTitle)
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") {
                        showingEditor = true
                    }
                    .disabled(model.page == nil)
                }
            }
            .sheet(isPresented: $showingEditor) {
                if let page = model.page {
                    NavigationStack {
                        NoteEditorView(page: page, api: api) { savedPage in
                            model.accept(savedPage)
                        }
                    }
                }
            }
            .task(id: pageID) {
                if model.pageID != pageID {
                    model = ReaderViewModel(pageID: pageID, api: api)
                }
                model.load()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView("Opening page…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case let .loaded(page):
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(page.path)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    MarkdownPreview(markdown: page.body)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }

        case let .failed(message):
            ContentUnavailableView {
                Label("Unable to open page", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") {
                    model.retry()
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private var navigationTitle: String {
        guard let page = model.page else { return "Reader" }
        let title = page.meta.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? page.path : title
    }
}
