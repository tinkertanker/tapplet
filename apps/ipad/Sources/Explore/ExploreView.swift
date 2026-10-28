import SwiftUI

struct ExploreView: View {
    let store: TappletStore

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var query = ""
    @State private var selectedSubjectID: String?
    @State private var selectedTopicID: String?
    @State private var selectedFormID: String?
    @State private var copyingProjectIDs: Set<String> = []
    @State private var preview: ArtifactProject?
    @State private var error: String?

    private var subjects: [ExampleCatalog.Subject] {
        ExampleCatalog.subjects(in: store.examples)
    }

    private var topics: [ExampleCatalog.Topic] {
        guard let selectedSubjectID else { return [] }
        return ExampleCatalog.topics(in: store.examples, subjectID: selectedSubjectID)
    }

    private var filteredProjects: [ArtifactProject] {
        ExampleCatalog.filteredProjects(
            store.examples,
            query: query,
            subjectID: selectedSubjectID,
            topicID: selectedTopicID,
            formID: selectedFormID
        )
    }

    private var hasActiveFilters: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || selectedSubjectID != nil
            || selectedTopicID != nil
            || selectedFormID != nil
    }

    private var columns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.adaptive(minimum: 310), spacing: 18)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                PageHeader(
                    title: "Start with an example",
                    subtitle: "A tapplet is a small interactive activity students open from a link. Preview an example, then make a copy or use its plan.",
                    sticker: .greetings
                )

                if store.examples.isEmpty {
                    unavailableState
                } else {
                    let projects = filteredProjects
                    catalogControls
                    results(projects)
                }
            }
            .padding(32)
        }
        .onChange(of: selectedSubjectID) {
            selectedTopicID = nil
        }
        .fullScreenCover(item: $preview) { project in
            StudentPreviewView(
                project: project,
                onUsePlan: store.isCreatingGuidedDraft
                    ? nil
                    : StarterPlan.matching(exampleID: project.artifact.id).map { plan in
                        { store.applyStarterPlan(plan) }
                    }
            )
        }
        .alert(
            "Could not make a copy",
            isPresented: Binding(
                get: { error != nil },
                set: { if !$0 { error = nil } }
            )
        ) {
            Button("OK") {}
        } message: {
            Text(error ?? "")
        }
    }

    private var catalogControls: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(TappletTheme.mutedInk)
                    .accessibilityHidden(true)
                TextField("Search title, subject, topic, or level", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .accessibilityLabel("Search examples")
                    .accessibilityIdentifier("example-search")
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(TappletTheme.mutedInk)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .frame(minHeight: 54)
            .background(TappletTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(TappletTheme.border, lineWidth: 1)
            }

            filterGroup(title: "Form") {
                CatalogFilterPill(
                    title: "All",
                    group: "Form",
                    isSelected: selectedFormID == nil,
                    accessibilityIdentifier: "form-filter-all"
                ) {
                    selectedFormID = nil
                }
                CatalogFilterPill(
                    title: "Games",
                    group: "Form",
                    isSelected: selectedFormID == "game",
                    accessibilityIdentifier: "form-filter-game"
                ) {
                    selectedFormID = "game"
                }
            }

            filterGroup(title: "Subject") {
                CatalogFilterPill(
                    title: "All",
                    group: "Subject",
                    isSelected: selectedSubjectID == nil,
                    accessibilityIdentifier: "subject-filter-all"
                ) {
                    selectedSubjectID = nil
                }
                ForEach(subjects) { subject in
                    CatalogFilterPill(
                        title: subject.title,
                        group: "Subject",
                        isSelected: selectedSubjectID == subject.id,
                        accessibilityIdentifier: "subject-filter-\(subject.id)"
                    ) {
                        selectedSubjectID = subject.id
                    }
                }
            }

            if !topics.isEmpty {
                filterGroup(title: "Topic") {
                    CatalogFilterPill(
                        title: "All topics",
                        group: "Topic",
                        isSelected: selectedTopicID == nil,
                        accessibilityIdentifier: "topic-filter-all"
                    ) {
                        selectedTopicID = nil
                    }
                    ForEach(topics) { topic in
                        CatalogFilterPill(
                            title: topic.title,
                            group: "Topic",
                            isSelected: selectedTopicID == topic.id,
                            accessibilityIdentifier: "topic-filter-\(topic.id)"
                        ) {
                            selectedTopicID = topic.id
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func filterGroup<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(TappletTheme.Typography.eyebrow)
                .foregroundStyle(TappletTheme.mutedInk)
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    content()
                }
                .padding(.top, 2)
                .padding(.bottom, 10)
            }
            .scrollClipDisabled()
        }
    }

    @ViewBuilder
    private func results(_ projects: [ArtifactProject]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            resultsHeader(count: projects.count)

            if projects.isEmpty {
                emptyResultsState
            } else {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                    ForEach(projects) { project in
                        let isCopying = copyingProjectIDs.contains(project.id)
                        AppletProjectCard(
                            project: project,
                            primaryTitle: "Preview",
                            onPrimary: { preview = project },
                            primaryIsDisabled: isCopying,
                            primaryAccessibilityHint: "Opens the activity in a full-screen student preview.",
                            secondaryTitle: isCopying ? "Making a copy…" : "Make a copy",
                            onSecondary: { makeCopy(of: project) },
                            secondaryIsLoading: isCopying,
                            secondaryAccessibilityHint: "Creates an editable copy and opens it."
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func resultsHeader(count: Int) -> some View {
        let resultCount = Text("\(count) \(count == 1 ? "example" : "examples")")
            .font(TappletTheme.Typography.section)
            .foregroundStyle(TappletTheme.ink)
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 10) {
                resultCount
                clearFiltersButton
            }
        } else {
            HStack {
                resultCount
                Spacer()
                clearFiltersButton
            }
        }
    }

    @ViewBuilder
    private var clearFiltersButton: some View {
        if hasActiveFilters {
            Button {
                clearFilters()
            } label: {
                Label("Clear search and filters", systemImage: "xmark.circle")
            }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(TappletTheme.accent)
            .accessibilityIdentifier("clear-example-filters")
        }
    }

    private var emptyResultsState: some View {
        VStack(spacing: 14) {
            Image(systemName: "magnifyingglass")
                .font(.largeTitle)
                .foregroundStyle(TappletTheme.mutedInk)
                .accessibilityHidden(true)
            Text("No examples found")
                .font(TappletTheme.Typography.question)
                .foregroundStyle(TappletTheme.ink)
            Text("Try another search or clear your filters.")
                .foregroundStyle(TappletTheme.mutedInk)
                .multilineTextAlignment(.center)
            Button("Clear search and filters") {
                clearFilters()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 52)
    }

    private var unavailableState: some View {
        ContentUnavailableView {
            Label {
                Text("Examples are unavailable")
            } icon: {
                PressedAppletMark(size: 72, rotation: .degrees(8))
            }
        } description: {
            Text("Tapplet Studio could not load its bundled activities.")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 52)
    }

    private func makeCopy(of project: ArtifactProject) {
        guard copyingProjectIDs.insert(project.id).inserted else { return }
        Task {
            defer { copyingProjectIDs.remove(project.id) }
            do {
                try await store.remix(project)
            } catch {
                self.error = store.errorMessage(for: error)
            }
        }
    }

    private func clearFilters() {
        query = ""
        selectedSubjectID = nil
        selectedTopicID = nil
        selectedFormID = nil
    }
}
