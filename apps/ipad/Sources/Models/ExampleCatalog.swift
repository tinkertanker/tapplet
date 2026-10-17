import Foundation

struct ExampleCatalog {
    struct Subject: Identifiable, Equatable {
        let id: String
        let title: String
    }

    struct Topic: Identifiable, Equatable {
        let id: String
        let subjectID: String
        let title: String
        let tagKeys: Set<String>
    }

    private static let knownSubjects = [
        Subject(id: "mathematics", title: "Mathematics"),
        Subject(id: "science", title: "Science"),
        Subject(id: "english", title: "English"),
        Subject(id: "humanities", title: "Humanities"),
        Subject(id: "civics", title: "Civics"),
        Subject(id: "languages", title: "Languages"),
        Subject(id: "other", title: "Classroom"),
        Subject(id: "unspecified", title: "Other")
    ]

    private static let curatedTopics = [
        Topic(id: "fractions", subjectID: "mathematics", title: "Fractions", tagKeys: ["fractions", "equivalence"]),
        Topic(id: "geometry-measurement", subjectID: "mathematics", title: "Geometry & measurement", tagKeys: ["perimeter", "rectangles"]),
        Topic(id: "algebra", subjectID: "mathematics", title: "Algebra", tagKeys: ["algebra", "linear functions"]),
        Topic(id: "times-tables", subjectID: "mathematics", title: "Times tables", tagKeys: ["times tables", "multiplication", "fluency"]),
        Topic(id: "graphs", subjectID: "mathematics", title: "Graphs", tagKeys: ["graphs"]),
        Topic(id: "averages", subjectID: "mathematics", title: "Averages", tagKeys: ["mean", "median", "data"]),
        Topic(id: "scientific-inquiry", subjectID: "science", title: "Scientific inquiry", tagKeys: ["science inquiry", "variables", "fair test"]),
        Topic(id: "biology", subjectID: "science", title: "Biology", tagKeys: ["biology", "cells", "organelles"]),
        Topic(id: "light", subjectID: "science", title: "Light", tagKeys: ["light", "shadows", "prediction"]),
        Topic(id: "electricity", subjectID: "science", title: "Electricity", tagKeys: ["electricity", "conductors", "insulators"]),
        Topic(id: "writing", subjectID: "english", title: "Writing", tagKeys: ["writing", "paragraphs", "cohesion"]),
        Topic(id: "persuasion", subjectID: "english", title: "Persuasion", tagKeys: ["persuasion", "rhetoric", "audience"]),
        Topic(id: "editing", subjectID: "english", title: "Editing", tagKeys: ["editing", "concision", "word choice"]),
        Topic(id: "spelling", subjectID: "english", title: "Spelling", tagKeys: ["spelling", "vocabulary"]),
        Topic(id: "geography", subjectID: "humanities", title: "Geography", tagKeys: ["geography", "urban flooding", "fieldwork"]),
        Topic(id: "history-sources", subjectID: "humanities", title: "History & sources", tagKeys: ["history", "sources", "corroboration"]),
        Topic(id: "civic-budget", subjectID: "civics", title: "Budgets & trade-offs", tagKeys: ["civics", "budgets", "trade offs"])
    ]

    static func subjects(in projects: [ArtifactProject]) -> [Subject] {
        let representedIDs = Set(projects.map(subjectID(for:)))
        let known = knownSubjects.filter { representedIDs.contains($0.id) }
        let knownIDs = Set(knownSubjects.map(\.id))
        let unknown = representedIDs
            .subtracting(knownIDs)
            .map { Subject(id: $0, title: displayName($0)) }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        return known + unknown
    }

    static func topics(in projects: [ArtifactProject], subjectID: String) -> [Topic] {
        let subjectProjects = projects.filter { self.subjectID(for: $0) == subjectID }
        return curatedTopics.filter { topic in
            topic.subjectID == subjectID
                && subjectProjects.contains { matches($0, topic: topic) }
        }
    }

    static func filteredProjects(
        _ projects: [ArtifactProject],
        query: String,
        subjectID: String?,
        topicID: String?,
        formID: String? = nil
    ) -> [ArtifactProject] {
        let terms = normalize(query).split(whereSeparator: \.isWhitespace)
        let selectedTopic = topicID.flatMap { id in curatedTopics.first { $0.id == id } }
        guard topicID == nil || selectedTopic != nil else { return [] }

        return projects.filter { project in
            if let subjectID, self.subjectID(for: project) != subjectID {
                return false
            }
            if let selectedTopic, !matches(project, topic: selectedTopic) {
                return false
            }
            if let formID, !matchesForm(project, formID: formID) {
                return false
            }
            guard !terms.isEmpty else { return true }
            let searchableText = searchText(for: project)
            return terms.allSatisfy { searchableText.contains($0) }
        }
    }

    private static func subjectID(for project: ArtifactProject) -> String {
        guard let subject = project.artifact.subject else { return "unspecified" }
        let normalized = normalize(subject)
        return normalized.isEmpty ? "unspecified" : normalized
    }

    private static func matches(_ project: ArtifactProject, topic: Topic) -> Bool {
        let tags = Set(project.artifact.tags.map(normalize))
        return !tags.isDisjoint(with: topic.tagKeys)
    }

    private static func matchesForm(_ project: ArtifactProject, formID: String) -> Bool {
        if let form = project.artifact.form, !form.isEmpty {
            return normalize(form) == normalize(formID)
        }
        return project.artifact.tags.map(normalize).contains(normalize(formID))
    }

    private static func searchText(for project: ArtifactProject) -> String {
        let artifact = project.artifact
        let topicTitles = curatedTopics
            .filter { $0.subjectID == subjectID(for: project) && matches(project, topic: $0) }
            .map(\.title)
            .joined(separator: " ")
        return normalize([
            artifact.title,
            artifact.summary,
            artifact.learningObjective ?? "",
            subjectTitle(for: subjectID(for: project)),
            displayName(artifact.level ?? ""),
            topicTitles,
            artifact.tags.joined(separator: " ")
        ].joined(separator: " "))
    }

    private static func subjectTitle(for id: String) -> String {
        knownSubjects.first { $0.id == id }?.title ?? displayName(id)
    }

    private static func displayName(_ value: String) -> String {
        normalize(value).capitalized
    }

    private static func normalize(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
}
