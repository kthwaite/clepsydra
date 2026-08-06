import ClepsydraCore
import SwiftUI

@MainActor
public struct SearchView: View {
    @Binding private var query: String
    @State private var model: SearchViewModel
    private let openPage: (UUID) -> Void
    private let createPage: () -> Void

    public init(
        query: Binding<String>,
        api: any VaultAPI,
        openPage: @escaping (UUID) -> Void,
        createPage: @escaping () -> Void
    ) {
        self._query = query
        self._model = State(initialValue: SearchViewModel(api: api))
        self.openPage = openPage
        self.createPage = createPage
    }

    public var body: some View {
        content
            .searchable(text: $query, prompt: "Search your vault")
            .onAppear {
                if model.query != query {
                    model.updateQuery(query)
                }
            }
            .onChange(of: query) { _, newQuery in
                model.updateQuery(newQuery)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: createPage) {
                        Label("New Note", systemImage: "square.and.pencil")
                    }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle:
            ContentUnavailableView(
                "Search your vault",
                systemImage: "magnifyingglass",
                description: Text("Enter a search term to find pages.")
            )

        case .loading:
            ProgressView("Searching…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case let .loaded(results):
            if results.isEmpty {
                ContentUnavailableView(
                    "No results",
                    systemImage: "magnifyingglass",
                    description: Text("Try a different search term.")
                )
            } else {
                List(results) { result in
                    Button {
                        openPage(result.pageID)
                    } label: {
                        SearchResultRow(result: result)
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
            }

        case let .failed(message):
            ContentUnavailableView {
                Label("Search failed", systemImage: "exclamationmark.triangle")
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
}
