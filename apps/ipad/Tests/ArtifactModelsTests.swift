import XCTest
@testable import Tapplet

final class ArtifactModelsTests: XCTestCase {
    func testArtifactResponseDecodesHeadHTMLAndRevision() throws {
        let data = Data(#"{"id":"a1","title":"Forces","summary":"Check forces","tags":[],"creationBrief":"brief","headRevisionId":"r1","createdAt":"2026-08-02T00:00:00Z","updatedAt":"2026-08-02T00:00:00Z","headRevision":{"id":"r1","artifactId":"a1","sourceHash":"abc","byteLength":20,"kind":"generate","model":"model","promptVersion":"1","createdAt":"2026-08-02T00:00:00Z"},"html":"<html></html>"}"#.utf8)
        let artifact = try JSONDecoder().decode(Artifact.self, from: data)
        XCTAssertEqual(artifact.headRevision?.kind, .generate)
        XCTAssertEqual(artifact.html, "<html></html>")
        XCTAssertEqual(artifact.createdAt, "2026-08-02T00:00:00Z", "ISO timestamps remain wire-format strings")
    }

    @MainActor func testBundledHTMLExampleLoads() {
        let store = TappletStore(storageDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), bundle: Bundle(for: TappletStore.self))
        XCTAssertEqual(store.examples.count, 18)
        XCTAssertTrue(store.examples.allSatisfy { $0.source.html.contains("<html") })
    }

    @MainActor func testRelativeAssetURLResolvesThroughControlledPreviewScheme() throws {
        let url = try XCTUnwrap(URL(string: "assets/image-1", relativeTo: AssetSchemeHandler.documentBaseURL)?.absoluteURL)
        XCTAssertEqual(url.absoluteString, "tapplet-preview://preview/assets/image-1")
        XCTAssertEqual(AssetSchemeHandler.assetID(from: url), "image-1")
    }
}

final class ExampleCatalogTests: XCTestCase {
    @MainActor
    func testSearchMatchesNormalizedMetadataAcrossFields() {
        let examples = bundledExamples()

        XCTAssertEqual(
            ids(in: examples, matching: "upper primary fractions"),
            ["fraction-equivalence-diagnostic"]
        )
        XCTAssertEqual(
            ids(in: examples, matching: "urban flooding"),
            ["catchment-under-pressure"]
        )
        XCTAssertEqual(
            ids(in: examples, matching: "secondary geography"),
            ["catchment-under-pressure"]
        )
        XCTAssertEqual(
            ids(in: examples, matching: "town council budget"),
            ["town-council-budget"]
        )
        XCTAssertEqual(
            ids(in: examples, matching: "geometry measurement"),
            ["fixed-perimeter-rectangle-explorer"]
        )
    }

    @MainActor
    func testSubjectAndTopicFiltersPreserveCuratedOrder() {
        let examples = bundledExamples()

        XCTAssertEqual(
            ExampleCatalog.filteredProjects(
                examples,
                query: "secondary",
                subjectID: "humanities",
                topicID: "geography"
            ).map(\.id),
            ["catchment-under-pressure"]
        )
        XCTAssertEqual(
            ExampleCatalog.filteredProjects(
                examples,
                query: "",
                subjectID: "humanities",
                topicID: "history-sources"
            ).map(\.id),
            ["source-reliability-check"]
        )
    }

    @MainActor
    func testCatalogDerivesOnlyRepresentedSubjectsAndTopics() {
        let examples = bundledExamples()

        XCTAssertEqual(
            ExampleCatalog.subjects(in: examples).map(\.title),
            ["Mathematics", "Science", "English", "Humanities", "Civics"]
        )
        XCTAssertEqual(
            ExampleCatalog.topics(in: examples, subjectID: "humanities").map(\.title),
            ["Geography", "History & sources"]
        )
    }

    @MainActor
    func testGamesFormFilterReturnsOnlyGameTaggedExamples() {
        let examples = bundledExamples()
        let games = ExampleCatalog.filteredProjects(
            examples,
            query: "",
            subjectID: nil,
            topicID: nil,
            formID: "game"
        )
        XCTAssertEqual(games.count, 4)
        XCTAssertTrue(games.allSatisfy { $0.artifact.form == "game" })
        XCTAssertEqual(
            Set(games.map(\.id)),
            [
                "conductor-or-insulator",
                "line-golf",
                "spell-it-before-the-sun-sets",
                "times-tables-lightning"
            ]
        )
    }

    @MainActor
    func testGamesFormFilterPrefersDecodedFormOverTags() {
        var taggedQuiz = bundledExamples()[0]
        taggedQuiz.artifact.form = "quiz"
        taggedQuiz.artifact.tags = ["game", "fractions"]
        var untaggedGame = bundledExamples()[1]
        untaggedGame.artifact.form = "game"
        untaggedGame.artifact.tags = ["fractions"]

        XCTAssertTrue(
            ExampleCatalog.filteredProjects(
                [taggedQuiz],
                query: "",
                subjectID: nil,
                topicID: nil,
                formID: "game"
            ).isEmpty
        )
        XCTAssertEqual(
            ExampleCatalog.filteredProjects(
                [untaggedGame],
                query: "",
                subjectID: nil,
                topicID: nil,
                formID: "game"
            ).map(\.id),
            [untaggedGame.id]
        )
    }

    @MainActor
    private func bundledExamples() -> [ArtifactProject] {
        TappletStore(
            storageDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString),
            bundle: Bundle(for: TappletStore.self)
        ).examples
    }

    private func ids(in examples: [ArtifactProject], matching query: String) -> [String] {
        ExampleCatalog.filteredProjects(
            examples,
            query: query,
            subjectID: nil,
            topicID: nil
        ).map(\.id)
    }
}
