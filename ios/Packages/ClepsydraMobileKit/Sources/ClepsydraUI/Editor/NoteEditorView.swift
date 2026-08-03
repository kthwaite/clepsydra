import ClepsydraCore
import SwiftUI

@MainActor
public struct NoteEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: EditorViewModel
    private let onSaved: ((PageDetail) -> Void)?

    @State private var showingDiscardConfirmation = false

    public init(
        mode: EditorViewModel.Mode,
        api: any VaultAPI,
        onSaved: ((PageDetail) -> Void)? = nil
    ) {
        self.onSaved = onSaved
        _model = State(initialValue: EditorViewModel(mode: mode, api: api))
    }

    public init(
        page: PageDetail,
        api: any VaultAPI,
        onSaved: ((PageDetail) -> Void)? = nil
    ) {
        self.init(mode: .edit(page), api: api, onSaved: onSaved)
    }

    public var body: some View {
        @Bindable var model = model

        VStack(spacing: 0) {
            Picker("View", selection: $model.presentationMode) {
                Text("Edit").tag(EditorViewModel.PresentationMode.edit)
                Text("Preview").tag(EditorViewModel.PresentationMode.preview)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.top)

            content
        }
        .navigationTitle(model.mode.isCreate ? "New Note" : "Edit Note")
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    requestCancel()
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    model.save()
                }
                .disabled(!model.canSave)
            }
            if case .failed = model.phase {
                ToolbarItem(placement: .primaryAction) {
                    Button("Retry") {
                        model.retry()
                    }
                    .disabled(!model.canSave)
                }
            }
        }
        .interactiveDismissDisabled(model.isDirty)
        .confirmationDialog(
            "Discard changes?",
            isPresented: $showingDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive) {
                model.cancel()
                dismiss()
            }
            Button("Keep Editing", role: .cancel) {}
        } message: {
            Text("Your unsaved title and Markdown will be lost.")
        }
        .alert(
            "Page changed on server",
            isPresented: Binding(
                get: { model.isConflictPresented },
                set: { presented in
                    if !presented { model.keepDraft() }
                }
            )
        ) {
            Button("Reload Server Version") {
                model.reloadFromServer()
            }
            Button("Keep Draft") {
                model.keepDraft()
            }
        } message: {
            Text("The server has a newer version. Reload it before saving again, or keep this draft without sending it.")
        }
        .alert("Page deleted", isPresented: Binding(
            get: { model.phase == .deleted },
            set: { _ in }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "This page was deleted on the server.")
        }
        .onChange(of: model.lastSavedPage) { _, page in
            guard let page else { return }
            onSaved?(page)
            dismiss()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.presentationMode {
        case .edit:
            editContent
        case .preview:
            ScrollView {
                MarkdownPreview(markdown: model.previewMarkdown)
                    .padding()
            }
        }
    }

    private var editContent: some View {
        Form {
            Section("Title") {
                TextField("Note title", text: $model.title)
#if os(iOS)
                    .textInputAutocapitalization(.sentences)
#endif
            }

            Section("Markdown") {
                TextEditor(text: $model.body)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 260)
            }

            if let errorMessage = model.errorMessage, !model.isInConflict, model.phase != .deleted {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                    Button("Retry") {
                        model.retry()
                    }
                    .disabled(!model.canSave)
                }
            }
        }
    }

    private func requestCancel() {
        if model.isDirty {
            showingDiscardConfirmation = true
        } else {
            model.cancel()
            dismiss()
        }
    }
}

private extension EditorViewModel.Mode {
    var isCreate: Bool {
        if case .create = self { return true }
        return false
    }
}
