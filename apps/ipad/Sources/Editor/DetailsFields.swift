import SwiftUI

struct DetailsFields: View {
    let store: TappletStore
    let project: ArtifactProject
    @State private var draft: Artifact
    @State private var error: String?

    init(store: TappletStore, project: ArtifactProject) {
        self.store = store
        self.project = project
        _draft = State(initialValue: project.artifact)
    }

    var body: some View {
        Group {
            TextField("Title", text: $draft.title)
            TextField("Summary", text: $draft.summary, axis: .vertical)
            TextField("Subject", text: optional($draft.subject))
            TextField("Level", text: optional($draft.level))
            TextField("Locale", text: optional($draft.locale))
            TextField("Learning objective", text: optional($draft.learningObjective), axis: .vertical)
            TextField("Tags (comma separated)", text: Binding(
                get: { draft.tags.joined(separator: ", ") },
                set: { draft.tags = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
            ))
            Button("Save details") {
                Task {
                    var details = draft
                    details.tags.removeAll { $0.isEmpty }
                    let optionalFields: [WritableKeyPath<Artifact, String?>] = [\.subject, \.level, \.locale, \.learningObjective]
                    for field in optionalFields where details[keyPath: field]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                        details[keyPath: field] = nil
                    }
                    do {
                        try await store.updateDetails(details)
                        error = nil
                    } catch {
                        self.error = store.errorMessage(for: error)
                    }
                }
            }
            if let error { Text(error).foregroundStyle(TappletTheme.danger) }
        }
    }

    private func optional(_ value: Binding<String?>) -> Binding<String> {
        Binding(get: { value.wrappedValue ?? "" }, set: { value.wrappedValue = $0.isEmpty ? nil : $0 })
    }
}
