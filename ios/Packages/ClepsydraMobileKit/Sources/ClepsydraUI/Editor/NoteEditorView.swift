import ClepsydraCore
import SwiftUI

@MainActor
public struct NoteEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: EditorViewModel
    private let onSaved: ((PageDetail) -> Void)?

    @State private var showingDiscardConfirmation = false
    @State private var showingDeletionAlert = false
    @State private var editingController = MarkdownEditingController()

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
            if model.isProtected {
                protectedContent
            } else {
                Picker("View", selection: $model.presentationMode) {
                    Text("Edit").tag(EditorViewModel.PresentationMode.edit)
                    Text("Preview").tag(EditorViewModel.PresentationMode.preview)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.top)

                content
            }
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
        .alert("Page deleted", isPresented: $showingDeletionAlert) {
            Button("OK", role: .cancel) {
                showingDeletionAlert = false
            }
        } message: {
            Text(model.errorMessage ?? "This page was deleted on the server.")
        }
        .onChange(of: model.phase) { _, phase in
            showingDeletionAlert = phase == .deleted
        }
        .onChange(of: model.lastSavedPage) { _, page in
            guard let page else { return }
            onSaved?(page)
            dismiss()
        }
    }

    private var protectedContent: some View {
        ContentUnavailableView {
            Label("Protected note", systemImage: "lock.fill")
        } description: {
            VStack(spacing: 8) {
                Text(model.title)
                    .font(.headline)
                if let path = model.sourcePage?.path {
                    Text(path)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Text("Open this note in the Clepsydra web frontend to unlock or edit it.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        @Bindable var model = model

        // Deliberately not a Form: a Markdown body needs the whole screen and
        // its own scrolling, which a form row cannot give it.
        return VStack(spacing: 0) {
            TextField("Note title", text: $model.title)
                .font(.title3.weight(.semibold))
#if os(iOS)
                .textInputAutocapitalization(.sentences)
#endif
                .padding(.horizontal, 16)
                .padding(.vertical, 12)

            Divider()

            if let errorMessage = model.errorMessage, !model.isInConflict, model.phase != .deleted {
                errorBanner(errorMessage)
                Divider()
            }

            MarkdownTextView(text: $model.body, controller: editingController)
        }
#if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                formatBar
            }
        }
#endif
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.red)
                .font(.footnote)
            Spacer(minLength: 0)
            Button("Retry") {
                model.retry()
            }
            .font(.footnote)
            .disabled(!model.canSave)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

#if os(iOS)
    @ViewBuilder
    private var formatBar: some View {
        ForEach(MarkdownEditingCommand.allCases, id: \.self) { command in
            Button {
                editingController.apply(command)
            } label: {
                Image(systemName: command.symbolName)
            }
            .accessibilityLabel(command.accessibilityName)
        }
        Spacer()
        Button("Done") {
            editingController.endEditing()
        }
    }
#endif

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
