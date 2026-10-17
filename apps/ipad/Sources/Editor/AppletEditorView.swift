import SwiftUI

struct AppletEditorView: View {
    let store: TappletStore
    let projectID: String
    @State private var prompt = ""
    @State private var showStudent = false
    @State private var showShare = false
    @State private var operationError: String?
    @State private var previewLoadState: PreviewLoadState = .loading
    @State private var previewError: String?
    @State private var isMovingHead = false
    @State private var shareAccessError: TappletAPIError?
    @State private var sharePresentationID = UUID()
    var project: ArtifactProject? { store.projects.first { $0.id == projectID } ?? store.examples.first { $0.id == projectID } }
    private var working: Bool { store.refiningProjectIDs.contains(projectID) }
    private var refinementError: String? { store.refinementErrors[projectID] }

    var body: some View {
        if let project {
            let presentationID = sharePresentationID
            VStack(spacing: 0) {
                HStack {
                    Button("Back", systemImage: "chevron.left") { store.closeEditor() }
                    Text(project.artifact.title).font(.headline).lineLimit(2).minimumScaleFactor(0.8).layoutPriority(1)
                    Spacer()
                    Button("Test as student") { showStudent = true }.disabled(previewLoadState != .ready)
                    if !project.isExample {
                        Button("Share") { sharePresentationID = UUID(); showShare = true }.buttonStyle(.borderedProminent)
                    }
                }
                .padding().background(TappletTheme.surface)
                HStack(spacing: 0) {
                    AppletPreviewWebView(
                        source: project.source,
                        localAssets: project.localAssets,
                        state: $previewLoadState,
                        presentableError: $previewError,
                        onSnapshot: { store.uploadSnapshot($0, revisionID: project.source.revision.id) }
                    )
                    .background(.white)
                    VStack {
                        if project.isExample {
                            Button("Make a copy") {
                                Task {
                                    do { try await store.remix(project) } catch { showOperationError(error) }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                        } else {
                            editor(project)
                        }
                    }
                    .frame(width: 360).background(TappletTheme.surface)
                }
            }
            .fullScreenCover(isPresented: $showStudent) { StudentPreviewView(project: project) }
            .sheet(isPresented: $showShare, onDismiss: {
                if let error = shareAccessError {
                    shareAccessError = nil
                    _ = store.present(error)
                }
            }) {
                ShareArtifactView(store: store, projectID: projectID) { error in
                    guard showShare, sharePresentationID == presentationID else { return }
                    shareAccessError = error
                    showShare = false
                }
            }
            .alert(
                "Tapplet Studio could not complete this action",
                isPresented: Binding(
                    get: { operationError != nil || refinementError != nil || previewError != nil },
                    set: { if !$0 { operationError = nil; store.refinementErrors[projectID] = nil; previewError = nil } }
                )
            ) {
                Button("OK") {}
            } message: {
                Text(operationError ?? refinementError ?? previewError ?? "")
            }
        } else {
            ContentUnavailableView {
                Label { Text("This tapplet is unavailable") } icon: { PressedAppletMark(size: 72, rotation: .degrees(21)) }
            }
        }
    }

    private func editor(_ project: ArtifactProject) -> some View {
        Form {
            Section("Ask Tapplet Studio") {
                if !working, let comment = project.source.revision.comment {
                    Label {
                        Text(comment)
                            .foregroundStyle(TappletTheme.ink)
                    } icon: {
                        Image(systemName: "text.bubble")
                            .foregroundStyle(TappletTheme.mutedInk)
                    }
                    .font(.callout)
                    .accessibilityIdentifier("latest-revision-comment")
                }
                TextEditor(text: $prompt).frame(height: 90)
                    .accessibilityLabel("Change to make")
                    .accessibilityHint("Describe what Tapplet Studio should change in this tapplet.")
                if ProcessInfo.processInfo.arguments.contains("--ui-testing-reset"),
                   ProcessInfo.processInfo.arguments.contains("--ui-testing-held-refinement"),
                   store.uiTestingRefinementIsWaiting {
                    Button("Complete test refinement") { store.completeUITestingRefinement() }
                        .accessibilityIdentifier("complete-test-refinement")
                }
                FlowLayout(spacing: 8) {
                    ForEach(RefineSuggestion.all) { suggestion in
                        Button(suggestion.title) { prompt = prompt.addingSuggestion(suggestion.title) }
                        .buttonStyle(TappletSecondaryButtonStyle(borderShape: .capsule))
                        .font(.subheadline)
                        .accessibilityIdentifier("refine-suggestion-\(suggestion.id)")
                    }
                }
                Button(working ? "Updating…" : "Make this change") {
                    let submittedPrompt = prompt
                    // The editor can close before the change finishes; the store keeps its state.
                    store.runChange(to: projectID) {
                        let warnings = try await store.refine(submittedPrompt, projectID: projectID)
                        if warnings.isEmpty && prompt == submittedPrompt { prompt = "" }
                    }
                }
                .disabled(working || isMovingHead || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Undo") {
                    isMovingHead = true
                    Task {
                        defer { isMovingHead = false }
                        do { try await store.undo(projectID: project.id) }
                        catch { showOperationError(error) }
                    }
                }
                .disabled(isMovingHead || working || project.source.revision.parentRevisionId == nil)
            }
            Section("Details") { DetailsFields(store: store, project: project) }
            Section("Images") {
                let referencedIDs = TappletStore.currentImageAssetIDs(in: project)
                ImageManagementView(store: store, projectID: project.id,
                                    assetIDs: referencedIDs.sorted(), isMovingHead: isMovingHead)
            }
            Section("History") {
                ForEach(project.revisions.reversed()) { revision in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(revision.instruction ?? revision.kind.rawValue.capitalized)
                            if let comment = revision.comment {
                                Text(comment).font(.callout).foregroundStyle(TappletTheme.mutedInk)
                            }
                            Text(revision.createdAt).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let url = revision.screenshotUrl {
                            AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { Color.gray.opacity(0.2) }
                                .frame(width: 64, height: 44).clipped()
                        }
                        Button("Restore") {
                            isMovingHead = true
                            Task {
                                defer { isMovingHead = false }
                                do { try await store.restore(revision: revision, projectID: project.id) }
                                catch { showOperationError(error) }
                            }
                        }
                        .disabled(isMovingHead || working || revision.id == project.artifact.headRevisionId)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("tapplet-editor-form")
    }
    private func showOperationError(_ error: Error) {
        operationError = store.errorMessage(for: error)
    }
}
