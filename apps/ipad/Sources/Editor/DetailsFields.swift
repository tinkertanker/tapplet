import SwiftUI

struct DetailsFields: View {
    let store: TappletStore
    let project: ArtifactProject
    @State private var draft: Artifact
    @State private var error: String?
    @State private var saving = false
    @State private var saved = false

    init(store: TappletStore, project: ArtifactProject) {
        self.store = store
        self.project = project
        _draft = State(initialValue: project.artifact)
    }

    var body: some View {
        Group {
            labeled("Title") { TextField("Title", text: $draft.title) }
            labeled("Summary") { TextField("Summary", text: $draft.summary, axis: .vertical) }
            labeled("Subject") { TextField("Subject", text: optional($draft.subject)) }
            labeled("Level") { TextField("Level", text: optional($draft.level)) }
            labeled("Language code") { TextField("For example en-SG", text: optional($draft.locale)) }
            labeled("Learning goal") { TextField("Learning goal", text: optional($draft.learningObjective), axis: .vertical) }
            labeled("Tags (separate with commas, up to 20)") {
                TextField("Tags", text: Binding(
                    get: { draft.tags.joined(separator: ", ") },
                    set: { draft.tags = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
                ))
            }
            Button(saving ? "Saving…" : "Save details") {
                saving = true
                saved = false
                Task {
                    defer { saving = false }
                    var details = draft
                    details.tags.removeAll { $0.isEmpty }
                    let optionalFields: [WritableKeyPath<Artifact, String?>] = [\.subject, \.level, \.locale, \.learningObjective]
                    for field in optionalFields where details[keyPath: field]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                        details[keyPath: field] = nil
                    }
                    do {
                        try await store.updateDetails(details)
                        error = nil
                        saved = true
                    } catch {
                        self.error = store.errorMessage(for: error)
                    }
                }
            }
            .disabled(saving)
            if saved { Label("Details saved", systemImage: "checkmark.circle").foregroundStyle(TappletTheme.mutedInk) }
            if let error { Text(error).foregroundStyle(TappletTheme.danger) }
        }
        // A later edit is not saved yet.
        .onChange(of: draft) { saved = false }
    }

    private func labeled<Field: View>(_ label: String, @ViewBuilder field: () -> Field) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(TappletTheme.mutedInk)
            field()
        }
    }

    private func optional(_ value: Binding<String?>) -> Binding<String> {
        Binding(get: { value.wrappedValue ?? "" }, set: { value.wrappedValue = $0.isEmpty ? nil : $0 })
    }
}
