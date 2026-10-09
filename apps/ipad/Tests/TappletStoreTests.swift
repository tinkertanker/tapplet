import Foundation
import XCTest
import UIKit
@testable import Tapplet

final class TappletStoreTests: XCTestCase {
    @MainActor
    func testGenerationCachesCanonicalHeadSource() async throws {
        let directory = temporaryDirectory()
        let generated = makeProject(revisionID: "r1", html: "<html><h1>Generated</h1></html>")
        let api = ArtifactAPIStub(generated: generated, revised: generated)
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))

        var brief = GuidedBriefDraft()
        brief.learningObjective = "Explain balanced forces"
        brief.studentAction = "Choose and explain"
        let result = try await store.createApprovedBrief(brief)

        XCTAssertEqual(result.artifact.headRevisionId, "r1")
        XCTAssertEqual(store.projects.first?.source.html, generated.source.html)
        let request = await api.lastGenerationRequest
        XCTAssertEqual(request?.brief.learningObjective, "Explain balanced forces")
        XCTAssertEqual(request?.brief.studentAction, "Choose and explain")
        XCTAssertNil(request?.preferredExampleRevisionId)

        let restored = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        XCTAssertEqual(restored.projects.first?.source.html, generated.source.html)
    }

    @MainActor
    func testSuccessfulGenerationPresentsAdvisoryWithoutDiscardingTheProject() async throws {
        let generated = makeProject(revisionID: "r1", html: "<html><h1>Generated</h1></html>")
        let warning = AdvisoryWarning(
            source: "prompt",
            code: "POSSIBLE_EMAIL",
            message: "AI review flagged a possible email address.",
            categories: ["personal information"]
        )
        let api = ArtifactAPIStub(generated: generated, revised: generated, warnings: [warning])
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Explain balanced forces"
        brief.studentAction = "Choose and explain"

        let project = try await store.createApprovedBrief(brief)

        XCTAssertEqual(project.id, generated.id)
        XCTAssertEqual(store.projects.first?.id, generated.id)
        XCTAssertEqual(store.advisoryNotice, warning.message)
    }

    @MainActor
    func testStarterPlanPrefillsBriefAndPinsExampleRevision() async throws {
        let directory = temporaryDirectory()
        let generated = makeProject(revisionID: "r1", html: "<html><h1>Generated</h1></html>")
        let api = ArtifactAPIStub(generated: generated, revised: generated)
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        let plan = try XCTUnwrap(StarterPlan.matching(exampleID: "times-tables-lightning"))

        store.applyStarterPlan(plan)

        XCTAssertEqual(store.selectedSection, .make)
        XCTAssertTrue(store.guidedMakeShowsSummary)
        XCTAssertEqual(store.guidedMakeDraft.format, .game)
        XCTAssertEqual(store.guidedMakeDraft.learnerContext, "Primary 5 Mathematics")
        XCTAssertEqual(store.guidedMakePreferredExampleRevisionId, "times-tables-lightning-seed")

        _ = try await store.createApprovedBrief(store.guidedMakeDraft)
        let request = await api.lastGenerationRequest
        XCTAssertEqual(request?.brief.format, "game")
        XCTAssertEqual(request?.preferredExampleRevisionId, "times-tables-lightning-seed")
    }

    @MainActor
    func testRewritingStarterPlanGoalDropsThePinnedExample() async throws {
        let generated = makeProject(revisionID: "r1", html: "<html><h1>Generated</h1></html>")
        let api = ArtifactAPIStub(generated: generated, revised: generated)
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        let plan = try XCTUnwrap(StarterPlan.matching(exampleID: "times-tables-lightning"))
        store.applyStarterPlan(plan)
        store.guidedMakeDraft.learnerContext = "Secondary 2 Geography"
        store.guidedMakeDraft.learningObjective = "Explain how rainfall affects flooding"

        XCTAssertNil(store.guidedMakeEffectivePreferredExampleRevisionId)

        _ = try await store.createApprovedBrief(store.guidedMakeDraft)
        let request = await api.lastGenerationRequest
        XCTAssertNil(request?.preferredExampleRevisionId)
        XCTAssertEqual(request?.brief.learnerContext, "Secondary 2 Geography")
    }

    @MainActor
    func testRefinementUsesCurrentExpectedHeadAndReplacesSourceAfterSuccess() async throws {
        let original = makeProject(revisionID: "r1", html: "<html>Original</html>")
        let revised = makeProject(
            revisionID: "r2",
            parentRevisionID: "r1",
            html: "<html>Revised</html>"
        )
        let api = ArtifactAPIStub(generated: original, revised: revised)
        let directory = temporaryDirectory()
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)

        try await store.refine("Use larger labels", projectID: original.id)

        let request = await api.lastRevisionRequest
        XCTAssertEqual(request?.instruction, "Use larger labels")
        XCTAssertEqual(request?.expectedHeadRevisionID, "r1")
        XCTAssertEqual(store.projects.first?.source.html, revised.source.html)
    }

    @MainActor
    func testRefinementForwardsARequiredManagedAsset() async throws {
        let original = makeProject(revisionID: "r1", html: "<html>Original</html>")
        let revised = makeProject(
            revisionID: "r2",
            parentRevisionID: "r1",
            html: "<html><img src=\"assets/asset-1\"></html>"
        )
        let api = ArtifactAPIStub(generated: original, revised: revised)
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)

        try await store.refine(
            "Insert the uploaded image.",
            projectID: original.id,
            requiredAssetID: "asset-1"
        )

        let request = await api.lastRevisionRequest
        XCTAssertEqual(request?.requiredAssetID, "asset-1")
    }

    @MainActor
    func testSuccessfulRefinementPresentsAdvisoryAndKeepsTheRevisedProject() async throws {
        let original = makeProject(revisionID: "r1", html: "<html>Original</html>")
        let revised = makeProject(
            revisionID: "r2",
            parentRevisionID: "r1",
            html: "<html>Revised</html>"
        )
        let warning = AdvisoryWarning(
            source: "prompt",
            code: "POSSIBLE_EMAIL",
            message: "AI review flagged a possible email address.",
            categories: ["personal information"]
        )
        let api = ArtifactAPIStub(generated: original, revised: revised, warnings: [warning])
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)
        store.advisoryNotice = nil

        let warnings = try await store.refine("Use larger labels", projectID: original.id)

        XCTAssertEqual(warnings, [warning])
        XCTAssertEqual(store.projects.first?.source.html, revised.source.html)
        XCTAssertEqual(store.advisoryNotice, warning.message)
    }

    @MainActor
    func testTechnicalRefinementFailurePreservesTheExistingAdvisory() async throws {
        let project = makeProject(revisionID: "r1", html: "<html>Original</html>")
        let warning = AdvisoryWarning(
            source: "prompt",
            code: "POSSIBLE_EMAIL",
            message: "AI review flagged a possible email address.",
            categories: nil
        )
        let api = ArtifactAPIStub(
            generated: project,
            revised: project,
            revisionError: .transport("offline"),
            warnings: [warning]
        )
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)

        do {
            _ = try await store.refine("Use larger labels", projectID: project.id)
            XCTFail("Expected the technical failure to remain blocking")
        } catch {}

        XCTAssertEqual(store.projects.first?.source.html, project.source.html)
        XCTAssertEqual(store.advisoryNotice, warning.message)
    }

    @MainActor
    func testSuccessfulPublishKeepsThePublicationAndPresentsItsAdvisory() async throws {
        let project = makeProject(revisionID: "r1", html: "<html>Original</html>")
        let warning = AdvisoryWarning(
            source: "publication",
            code: "AI_CONTENT_REVIEW_FLAGGED",
            message: "AI review flagged content that may need attention.",
            categories: nil
        )
        let api = ArtifactAPIStub(generated: project, revised: project, warnings: [warning])
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)
        store.advisoryNotice = nil

        let publication = try await store.publish(projectID: project.id)

        XCTAssertEqual(publication.slug, "class")
        XCTAssertEqual(store.projects.first?.artifact.publication?.slug, publication.slug)
        XCTAssertEqual(store.advisoryNotice, warning.message)
    }

    @MainActor
    func testUpdatingPublicationUsesCurrentRevisionAndClearsStaleStatus() async throws {
        var project = makeProject(revisionID: "r2", html: "<html>Updated</html>")
        project.artifact.publication = ArtifactPublication(
            slug: "class",
            url: URL(string: "https://example.test/class")!,
            title: "Artifact",
            createdAt: "2026-08-02T00:00:00Z",
            expiresAt: "2099-01-01T00:00:00Z"
        )
        project.artifact.publicationStale = true
        let api = ArtifactAPIStub(generated: project, revised: project)
        let store = TappletStore(api: api, storageDirectory: temporaryDirectory(), bundle: Bundle(for: Self.self))
        store.projects = [project]

        let publication = try await store.publish(projectID: project.id)

        let publishedRevisionID = await api.lastPublishedRevisionID
        XCTAssertEqual(publishedRevisionID, "r2")
        XCTAssertEqual(publication.url, project.artifact.publication?.url)
        XCTAssertEqual(store.projects.first?.artifact.publicationStale, false)
    }

    @MainActor
    func testExampleCopyUsesExactRemixWithoutGeneration() async throws {
        let example = makeProject(revisionID: "seed-revision", html: "<html>Seed</html>")
        let copy = makeProject(revisionID: "copy-revision", html: "<html>Seed</html>")
        let api = ArtifactAPIStub(generated: example, revised: copy)
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )

        try await store.remix(example)

        let remix = await api.lastRemixRequest
        let generation = await api.lastGenerationRequest
        XCTAssertEqual(remix?.artifactID, example.artifact.id)
        XCTAssertEqual(remix?.revisionID, example.source.revision.id)
        XCTAssertNil(generation)
        XCTAssertEqual(store.selectedProjectID, copy.id)
    }

    @MainActor
    func testFallbackExampleCopyUsesGenerationWithoutServerRevision() async throws {
        let fallback = makeProject(
            artifactID: "example-fallback",
            revisionID: "example-fallback-seed",
            html: "<html>Fallback</html>"
        )
        let copy = makeProject(revisionID: "copy-revision", html: "<html>Copy</html>")
        let api = ArtifactAPIStub(generated: copy, revised: copy)
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )

        try await store.remix(fallback)

        let generation = await api.lastGenerationRequest
        let remix = await api.lastRemixRequest
        XCTAssertEqual(generation?.creationBrief, fallback.artifact.creationBrief)
        XCTAssertNil(generation?.preferredExampleRevisionId)
        XCTAssertNil(remix)
        XCTAssertEqual(store.selectedProjectID, copy.id)
    }

    @MainActor
    func testOpenMakeRequestsAccessWhenRegistrationIsRequired() {
        let project = makeProject(revisionID: "r1", html: "<html></html>")
        let store = TappletStore(
            api: ArtifactAPIStub(generated: project, revised: project),
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        store.selectedProjectID = project.id
        store.workshopAccessState = .registrationRequired

        store.openMake()

        XCTAssertEqual(store.selectedSection, .make)
        XCTAssertNil(store.selectedProjectID)
        XCTAssertTrue(store.showsWorkshopAccess)
    }

    @MainActor
    func testMissingCredentialAndRegistrationErrorReopenWorkshopAccess() async {
        let project = makeProject(revisionID: "r1", html: "<html></html>")
        let api = ArtifactAPIStub(
            generated: project,
            revised: project,
            hasCredential: false
        )
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )

        await store.refreshWorkshopAccess()
        XCTAssertEqual(store.workshopAccessState, .registrationRequired)
        XCTAssertTrue(store.showsWorkshopAccess)

        store.dismissWorkshopAccess()
        let presentation = store.present(
            TappletAPIError.server(401, "DEVICE_REGISTRATION_REQUIRED", "Register again"),
            during: .generation
        )

        XCTAssertTrue(presentation.requestsWorkshopAccess)
        XCTAssertEqual(store.workshopAccessState, .registrationRequired)
        XCTAssertTrue(store.showsWorkshopAccess)

        store.dismissWorkshopAccess()
        let localPresentation = store.present(
            TappletAPIError.registrationRequired,
            during: .generation
        )
        XCTAssertTrue(localPresentation.requestsWorkshopAccess)
        XCTAssertTrue(store.showsWorkshopAccess)
    }

    @MainActor
    func testSuccessfulCredentialRefreshDoesNotCloseManuallyOpenedAccess() async {
        let project = makeProject(revisionID: "r1", html: "<html></html>")
        let store = TappletStore(
            api: ArtifactAPIStub(generated: project, revised: project),
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        store.requestWorkshopAccess()

        await store.refreshWorkshopAccess()

        XCTAssertEqual(store.workshopAccessState, .ready)
        XCTAssertTrue(store.showsWorkshopAccess)
    }

    @MainActor
    func testRestoreContinuesAfterOneArtifactFails() async throws {
        let failed = makeProject(
            artifactID: "failed",
            revisionID: "r1",
            html: "<html>Failed</html>"
        )
        let restored = makeProject(
            artifactID: "restored",
            revisionID: "r2",
            html: "<html>Restored</html>"
        )
        let api = ArtifactAPIStub(
            generated: restored,
            revised: restored,
            listedArtifacts: [failed.artifact, restored.artifact],
            artifactErrors: [
                failed.id: .server(404, "SOURCE_NOT_FOUND", "Missing source")
            ]
        )
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )

        let count = try await store.restoreFromTapplet()

        XCTAssertEqual(count, 1)
        XCTAssertEqual(store.projects.map(\.id), [restored.id])
        XCTAssertNotNil(store.recoveryNotice)
    }

    @MainActor
    func testRestoreContinuesAfterOneAssetDownloadFails() async throws {
        let failed = makeProject(
            artifactID: "failed",
            revisionID: "r1",
            html: #"<html><img src="assets/missing-image"></html>"#
        )
        let restored = makeProject(
            artifactID: "restored",
            revisionID: "r2",
            html: "<html>Restored</html>"
        )
        let api = ArtifactAPIStub(
            generated: restored,
            revised: restored,
            listedArtifacts: [failed.artifact, restored.artifact],
            projectsByID: [failed.id: failed, restored.id: restored],
            assetErrors: [
                "missing-image": .server(404, "ASSET_NOT_FOUND", "Missing asset")
            ]
        )
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )

        let count = try await store.restoreFromTapplet()

        XCTAssertEqual(count, 1)
        XCTAssertEqual(store.projects.map(\.id), [restored.id])
        XCTAssertNotNil(store.recoveryNotice)
    }

    @MainActor
    func testRestorePropagatesRegistrationFailures() async {
        let project = makeProject(revisionID: "r1", html: "<html></html>")
        let api = ArtifactAPIStub(
            generated: project,
            revised: project,
            artifactErrors: [project.id: .registrationRequired]
        )
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )

        do {
            _ = try await store.restoreFromTapplet()
            XCTFail("Expected registration to be requested")
        } catch let error as TappletAPIError {
            XCTAssertTrue(error.requiresRegistration)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(store.workshopAccessState, .registrationRequired)
        XCTAssertTrue(store.showsWorkshopAccess)
    }

    @MainActor
    func testDeleteRemovesLocalProjectWhenServerCopyHasExpired() async throws {
        let directory = temporaryDirectory()
        var project = makeProject(revisionID: "r1", html: "<html></html>")
        project.artifact.publication = ArtifactPublication(
            slug: "expired-link",
            url: URL(string: "https://example.test/expired-link")!,
            title: "Forces",
            createdAt: "1999-08-02T00:00:00Z",
            expiresAt: "2000-08-02T00:00:00Z"
        )
        let api = ArtifactAPIStub(
            generated: project,
            revised: project,
            deleteError: .server(404, "ARTIFACT_NOT_FOUND", "Missing artifact")
        )
        let store = TappletStore(
            api: api,
            storageDirectory: directory,
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)

        try await store.deleteProject(projectID: project.id)

        XCTAssertTrue(store.projects.isEmpty)
        let restored = TappletStore(
            api: api,
            storageDirectory: directory,
            bundle: Bundle(for: Self.self)
        )
        XCTAssertTrue(restored.projects.isEmpty)
    }

    @MainActor
    func testDeleteKeepsLocalProjectWhenMissingRemoteMayStillBePublished() async throws {
        var project = makeProject(revisionID: "r1", html: "<html></html>")
        project.artifact.publication = ArtifactPublication(
            slug: "active-link",
            url: URL(string: "https://example.test/active-link")!,
            title: "Forces",
            createdAt: "2026-08-02T00:00:00Z",
            expiresAt: "2099-11-02T00:00:00Z"
        )
        let api = ArtifactAPIStub(
            generated: project,
            revised: project,
            deleteError: .server(404, "ARTIFACT_NOT_FOUND", "Missing artifact")
        )
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)

        do {
            try await store.deleteProject(projectID: project.id)
            XCTFail("Expected deletion to preserve the active publication record")
        } catch let error as TappletAPIError {
            XCTAssertTrue(error.isArtifactNotFound)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(store.projects.map(\.id), [project.id])
    }

    @MainActor
    func testDeleteKeepsLocalProjectWhenPublicationExpiryIsMalformed() async throws {
        var project = makeProject(revisionID: "r1", html: "<html></html>")
        project.artifact.publication = ArtifactPublication(
            slug: "unknown-expiry-link",
            url: URL(string: "https://example.test/unknown-expiry-link")!,
            title: "Forces",
            createdAt: "2026-08-02T00:00:00Z",
            expiresAt: "not-a-date"
        )
        let api = ArtifactAPIStub(
            generated: project,
            revised: project,
            deleteError: .server(404, "ARTIFACT_NOT_FOUND", "Missing artifact")
        )
        let store = TappletStore(
            api: api,
            storageDirectory: temporaryDirectory(),
            bundle: Bundle(for: Self.self)
        )
        var brief = GuidedBriefDraft()
        brief.learningObjective = "Forces"
        brief.studentAction = "Choose"
        _ = try await store.createApprovedBrief(brief)

        do {
            try await store.deleteProject(projectID: project.id)
            XCTFail("Expected deletion to preserve the publication record")
        } catch let error as TappletAPIError {
            XCTAssertTrue(error.isArtifactNotFound)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(store.projects.map(\.id), [project.id])
    }

    @MainActor
    func testAssetExtractionMatchesManagedHtmlReferencesOnly() {
        let html = """
        <img src="assets/image-one">
        <a href=' assets/image-two '>Image</a>
        <style>.card { background: url(assets/image-three) }</style>
        <script>const example = "assets/not-a-reference";</script>
        """

        XCTAssertEqual(
            TappletStore.referencedAssetIDs(in: html),
            ["image-one", "image-two", "image-three"]
        )
    }

    @MainActor
    func testRemovedImageIsUsableAfterUndoAndPersistedReload() async throws {
        try await assertRemovedImageRestoration(useUndo: true)
    }

    @MainActor
    func testRemovedImageIsUsableAfterHistoryRestoreAndPersistedReload() async throws {
        try await assertRemovedImageRestoration(useUndo: false)
    }

    @MainActor
    private func assertRemovedImageRestoration(useUndo: Bool) async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let assetID = "restore-\(UUID().uuidString)"
        let image = try syntheticImage()
        let local = try LocalAppletAssetStorage.store(image, id: assetID)
        defer { LocalAppletAssetStorage.remove(local) }
        var original = makeProject(revisionID: "r1", html: "<html><img src=\"assets/\(assetID)\"></html>")
        original.localAssets = [local]
        var removed = makeProject(revisionID: "r2", parentRevisionID: "r1", html: "<html>No image</html>")
        removed.revisions = original.revisions + removed.revisions
        let api = ArtifactAPIStub(generated: original, revised: removed)
        await api.configureRestoredProject(original, image: image)
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        store.projects = [original]
        XCTAssertNotNil(LocalAppletAssetStorage.url(for: local))

        try await store.removeImage(assetID: assetID, projectID: original.id)
        XCTAssertTrue(TappletStore.referencedAssetIDs(in: try XCTUnwrap(store.projects.first).source.html).isEmpty)
        if useUndo { try await store.undo(projectID: original.id) }
        else { try await store.restore(revision: original.source.revision, projectID: original.id) }

        for candidate in [store, TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))] {
            let restored = try XCTUnwrap(candidate.projects.first)
            XCTAssertEqual(restored.source.html, original.source.html)
            let cached = restored.localAssets.first { $0.id == assetID }
            let url = cached.flatMap { LocalAppletAssetStorage.url(for: $0) }
            XCTAssertNotNil(url, "Restored HTML must have a usable local preview image, including after reload")
            if let url { XCTAssertNotNil(UIImage(data: try Data(contentsOf: url))) }
        }
    }

    @MainActor
    func testHistoricalImageCacheDoesNotConsumeCurrentImageLimit() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let image = try syntheticImage()
        var current = makeProject(revisionID: "r1", html: "<html>No current images</html>")
        current.localAssets = try (0..<3).map {
            try LocalAppletAssetStorage.store(image, id: "history-\(UUID().uuidString)-\($0)")
        }
        defer { current.localAssets.forEach { LocalAppletAssetStorage.remove($0) } }
        let revised = makeProject(revisionID: "r2", parentRevisionID: "r1", html: "<html><img src=\"assets/asset-1\"></html>")
        let api = ArtifactAPIStub(generated: current, revised: revised)
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        store.projects = [current]
        defer { store.projects.flatMap(\.localAssets).filter { $0.id == "asset-1" }.forEach { LocalAppletAssetStorage.remove($0) } }
        do {
            try await store.addImage(image.data, description: "A blue square", decorative: false, projectID: current.id)
        } catch {
            XCTFail("Three unreferenced history images must not block a current upload: \(error)")
        }
        let request = await api.lastRevisionRequest
        XCTAssertEqual(request?.requiredAssetID, "asset-1")
        XCTAssertEqual(TappletStore.referencedAssetIDs(in: try XCTUnwrap(store.projects.first).source.html), ["asset-1"])
    }

    @MainActor
    func testCurrentImageLimitCountsReferencesWithoutCachedFiles() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let current = makeProject(revisionID: "r1", html: """
        <html><img src="assets/one"><img src="assets/two"><img src="assets/three"></html>
        """)
        let api = ArtifactAPIStub(generated: current, revised: current)
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        store.projects = [current]
        defer { store.projects.flatMap(\.localAssets).forEach { LocalAppletAssetStorage.remove($0) } }
        do {
            try await store.addImage(syntheticImage().data, description: "A blue square", decorative: false, projectID: current.id)
            XCTFail("Three current references must block another upload even when the offline cache is empty")
        } catch let error as AppletImageError {
            XCTAssertEqual(error, .limitReached)
        }
        let request = await api.lastRevisionRequest
        XCTAssertNil(request, "The limit must be checked before uploading and revising")
    }

    @MainActor
    func testLateMetadataResponsePreservesNewHeadAndSavedDetails() async throws {
        try await assertLateMutationPreservesRevision(operation: "metadata")
    }

    @MainActor
    func testLateRevokeResponsePreservesNewHeadAndRevocation() async throws {
        try await assertLateMutationPreservesRevision(operation: "revoke")
    }

    @MainActor
    func testLateExtendResponsePreservesNewHeadAndExtension() async throws {
        try await assertLateMutationPreservesRevision(operation: "extend")
    }

    @MainActor
    private func assertLateMutationPreservesRevision(operation: String) async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var original = makeProject(revisionID: "r1", html: "<html>R1</html>")
        original.artifact.publication = regressionPublication()
        var revised = makeProject(revisionID: "r2", parentRevisionID: "r1", html: "<html>R2</html>")
        revised.revisions = original.revisions + revised.revisions
        revised.artifact.publication = original.artifact.publication
        revised.artifact.publicationStale = true
        let api = ArtifactAPIStub(generated: original, revised: revised)
        await api.hold(operation)
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        store.projects = [original]
        var details = original.artifact
        details.title = "Saved details"
        let submittedDetails = details
        let task = Task { @MainActor in
            switch operation {
            case "metadata": try await store.updateDetails(submittedDetails)
            case "revoke": try await store.unpublish(projectID: original.id)
            default: try await store.extendPublication(projectID: original.id)
            }
        }
        await api.waitUntilHeld()
        try await store.refine("Advance to R2", projectID: original.id)
        XCTAssertEqual(store.projects.first?.source.revision.id, "r2")
        await api.release()
        try await task.value
        for candidate in [store, TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))] {
            let project = try XCTUnwrap(candidate.projects.first)
            XCTAssertEqual(project.source, revised.source, "Late \(operation) must not roll source back to R1")
            XCTAssertEqual(project.artifact.headRevisionId, "r2")
            XCTAssertEqual(project.revisions, revised.revisions)
            switch operation {
            case "metadata": XCTAssertEqual(project.artifact.title, "Saved details")
            case "revoke": XCTAssertNil(project.artifact.publication)
            default: XCTAssertEqual(project.artifact.publication?.expiresAt, "2100-01-01T00:00:00Z")
            }
        }
    }

    @MainActor
    func testLatePublishOfR1KeepsR2PublicationStale() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = makeProject(revisionID: "r1", html: "<html>R1</html>")
        var revised = makeProject(revisionID: "r2", parentRevisionID: "r1", html: "<html>R2</html>")
        revised.artifact.publicationStale = true
        let api = ArtifactAPIStub(generated: original, revised: revised)
        await api.hold("publish")
        let store = TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))
        store.projects = [original]
        let task = Task { @MainActor in try await store.publish(projectID: original.id) }
        await api.waitUntilHeld()
        let publishedRevision = await api.lastPublishedRevisionID
        XCTAssertEqual(publishedRevision, "r1")
        try await store.refine("Advance to R2", projectID: original.id)
        await api.release()
        _ = try await task.value
        for candidate in [store, TappletStore(api: api, storageDirectory: directory, bundle: Bundle(for: Self.self))] {
            XCTAssertEqual(candidate.projects.first?.source.revision.id, "r2")
            XCTAssertNotNil(candidate.projects.first?.artifact.publication)
            XCTAssertEqual(candidate.projects.first?.artifact.publicationStale, true, "The link still serves R1")
        }
    }

    @MainActor
    private func syntheticImage() throws -> PreparedAppletImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16))
        let data = renderer.pngData { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        }
        return try AppletImageProcessor.prepare(data)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "TappletStoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    }
}

private actor ArtifactAPIStub: TappletAPI {
    struct RevisionRequest: Sendable {
        let instruction: String
        let expectedHeadRevisionID: String
        let requiredAssetID: String?
    }
    struct RemixRequest: Sendable {
        let artifactID: String
        let revisionID: String?
    }

    let generated: ArtifactProject
    let revised: ArtifactProject
    let hasCredential: Bool
    let listedArtifacts: [Artifact]
    let artifactErrors: [String: TappletAPIError]
    let projectsByID: [String: ArtifactProject]
    let assetErrors: [String: TappletAPIError]
    let deleteError: TappletAPIError?
    let revisionError: TappletAPIError?
    let warnings: [AdvisoryWarning]
    private(set) var lastGenerationRequest: GuidedGenerationRequest?
    private(set) var lastRevisionRequest: RevisionRequest?
    private(set) var lastRemixRequest: RemixRequest?
    private(set) var lastPublishedRevisionID: String?
    private var heldOperation: String?
    private var responseContinuation: CheckedContinuation<Void, Never>?
    private var arrivalContinuation: CheckedContinuation<Void, Never>?
    private var restoredProject: ArtifactProject?
    private var downloadedImage: PreparedAppletImage?

    func configureRestoredProject(_ project: ArtifactProject, image: PreparedAppletImage) {
        var project = project
        project.localAssets = [] // Server responses never contain local file records.
        restoredProject = project
        downloadedImage = image
    }
    func hold(_ operation: String) { heldOperation = operation }
    func waitUntilHeld() async {
        if responseContinuation != nil { return }
        await withCheckedContinuation { arrivalContinuation = $0 }
    }
    func release() {
        responseContinuation?.resume()
        responseContinuation = nil
        heldOperation = nil
    }
    private func suspendIfHeld(_ operation: String) async {
        guard heldOperation == operation else { return }
        await withCheckedContinuation { continuation in
            responseContinuation = continuation
            arrivalContinuation?.resume()
            arrivalContinuation = nil
        }
    }

    init(
        generated: ArtifactProject,
        revised: ArtifactProject,
        hasCredential: Bool = true,
        listedArtifacts: [Artifact]? = nil,
        artifactErrors: [String: TappletAPIError] = [:],
        projectsByID: [String: ArtifactProject] = [:],
        assetErrors: [String: TappletAPIError] = [:],
        deleteError: TappletAPIError? = nil,
        revisionError: TappletAPIError? = nil,
        warnings: [AdvisoryWarning] = []
    ) {
        self.generated = generated
        self.revised = revised
        self.hasCredential = hasCredential
        self.listedArtifacts = listedArtifacts ?? [generated.artifact]
        self.artifactErrors = artifactErrors
        self.projectsByID = projectsByID
        self.assetErrors = assetErrors
        self.deleteError = deleteError
        self.revisionError = revisionError
        self.warnings = warnings
    }

    func hasDeviceCredential() async -> Bool { hasCredential }
    func registerDevice(accessCode: String) async throws {}
    func generate(request: GuidedGenerationRequest) async throws -> AdvisoryResult<ArtifactProject> {
        lastGenerationRequest = request
        return AdvisoryResult(value: generated, warnings: warnings)
    }
    func listArtifacts() async throws -> [Artifact] { listedArtifacts }
    func searchExamples(brief: String) async throws -> [ExampleSearchDescriptor] { [] }
    func getArtifact(id: String) async throws -> ArtifactProject {
        if let error = artifactErrors[id] { throw error }
        return projectsByID[id] ?? generated
    }
    func updateArtifact(_ artifact: Artifact) async throws -> AdvisoryResult<Artifact> {
        await suspendIfHeld("metadata")
        return AdvisoryResult(value: artifact, warnings: warnings)
    }
    func deleteArtifact(id: String) async throws {
        if let deleteError { throw deleteError }
    }
    func revise(id: String, instruction: String, expectedHeadRevisionId: String, requiredAssetID: String?) async throws -> AdvisoryResult<ArtifactProject> {
        if let revisionError { throw revisionError }
        lastRevisionRequest = RevisionRequest(
            instruction: instruction,
            expectedHeadRevisionID: expectedHeadRevisionId,
            requiredAssetID: requiredAssetID
        )
        return AdvisoryResult(value: revised, warnings: warnings)
    }
    func revisions(id: String) async throws -> [ArtifactRevision] { generated.revisions }
    func source(revision: ArtifactRevision) async throws -> ArtifactSource { generated.source }
    func setHead(id: String, revisionId: String, expectedHeadRevisionId: String) async throws -> ArtifactProject { restoredProject ?? revised }
    func remix(id: String, revisionId: String?) async throws -> AdvisoryResult<ArtifactProject> {
        lastRemixRequest = RemixRequest(artifactID: id, revisionID: revisionId)
        return AdvisoryResult(value: revised, warnings: warnings)
    }
    func downloadAsset(id: String) async throws -> DownloadedAppletAsset {
        if let error = assetErrors[id] { throw error }
        if let downloadedImage { return DownloadedAppletAsset(data: downloadedImage.data, mediaType: downloadedImage.mediaType) }
        return DownloadedAppletAsset(data: Data([1, 2, 3]), mediaType: "image/jpeg")
    }
    func uploadScreenshot(revisionId: String, jpeg: Data) async throws {}
    func publish(id: String, revisionId: String) async throws -> AdvisoryResult<ArtifactPublication> {
        lastPublishedRevisionID = revisionId
        await suspendIfHeld("publish")
        return AdvisoryResult(value: ArtifactPublication(
            slug: "class",
            url: URL(string: "https://example.test/class")!,
            title: "Artifact",
            createdAt: "2026-08-02T00:00:00Z",
            expiresAt: "2026-11-02T00:00:00Z"
        ), warnings: warnings)
    }
    func revoke(slug: String) async throws { await suspendIfHeld("revoke") }
    func extend(slug: String, days: Int) async throws -> ArtifactPublication {
        if heldOperation == "extend" {
            await suspendIfHeld("extend")
            return regressionPublication(expiresAt: "2100-01-01T00:00:00Z")
        }
        return (try await publish(id: generated.id, revisionId: "r1")).value
    }
    func uploadImage(
        _ image: PreparedAppletImage,
        alternativeText: String?,
        decorative: Bool
    ) async throws -> AdvisoryResult<UploadedAppletImage> {
        AdvisoryResult(value: UploadedAppletImage(
            asset: AppletImageAssetRecord(
                id: "asset-1",
                kind: "image",
                mediaType: image.mediaType,
                width: image.width,
                height: image.height,
                byteLength: image.data.count,
                sha256: image.sha256
            ),
            accessibility: .init(alternativeText: alternativeText, decorative: decorative)
        ), warnings: warnings)
    }
}

private func regressionPublication(expiresAt: String = "2099-01-01T00:00:00Z") -> ArtifactPublication {
    ArtifactPublication(slug: "class", url: URL(string: "https://example.test/class")!, title: "Forces", createdAt: "2026-08-02T00:00:00Z", expiresAt: expiresAt)
}

private func makeProject(
    artifactID: String = "artifact-1",
    revisionID: String,
    parentRevisionID: String? = nil,
    html: String
) -> ArtifactProject {
    let timestamp = "2026-08-02T00:00:00Z"
    let revision = ArtifactRevision(
        id: revisionID,
        artifactId: artifactID,
        parentRevisionId: parentRevisionID,
        sourceHash: "hash-\(revisionID)",
        byteLength: html.utf8.count,
        kind: parentRevisionID == nil ? .generate : .revise,
        instruction: parentRevisionID == nil ? nil : "Use larger labels",
        model: "test-model",
        promptVersion: "test-v1",
        createdAt: timestamp
    )
    let artifact = Artifact(
        id: artifactID,
        title: "Forces",
        summary: "A forces check",
        tags: ["science"],
        creationBrief: "Create a forces check",
        headRevisionId: revisionID,
        createdAt: timestamp,
        updatedAt: timestamp,
        headRevision: revision,
        html: html
    )
    return ArtifactProject(
        artifact: artifact,
        source: ArtifactSource(revision: revision, html: html),
        revisions: [revision]
    )
}
