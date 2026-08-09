import Foundation
import XCTest
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

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "TappletStoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    }
}

private actor ArtifactAPIStub: TappletAPI {
    struct RevisionRequest: Sendable {
        let instruction: String
        let expectedHeadRevisionID: String
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
    let deleteError: TappletAPIError?
    private(set) var lastGenerationRequest: GuidedGenerationRequest?
    private(set) var lastRevisionRequest: RevisionRequest?
    private(set) var lastRemixRequest: RemixRequest?

    init(
        generated: ArtifactProject,
        revised: ArtifactProject,
        hasCredential: Bool = true,
        listedArtifacts: [Artifact]? = nil,
        artifactErrors: [String: TappletAPIError] = [:],
        deleteError: TappletAPIError? = nil
    ) {
        self.generated = generated
        self.revised = revised
        self.hasCredential = hasCredential
        self.listedArtifacts = listedArtifacts ?? [generated.artifact]
        self.artifactErrors = artifactErrors
        self.deleteError = deleteError
    }

    func hasDeviceCredential() async -> Bool { hasCredential }
    func registerDevice(accessCode: String) async throws {}
    func generate(request: GuidedGenerationRequest) async throws -> ArtifactProject {
        lastGenerationRequest = request
        return generated
    }
    func listArtifacts() async throws -> [Artifact] { listedArtifacts }
    func searchExamples(brief: String) async throws -> [ExampleSearchDescriptor] { [] }
    func getArtifact(id: String) async throws -> ArtifactProject {
        if let error = artifactErrors[id] { throw error }
        return generated
    }
    func updateArtifact(_ artifact: Artifact) async throws -> Artifact { artifact }
    func deleteArtifact(id: String) async throws {
        if let deleteError { throw deleteError }
    }
    func revise(id: String, instruction: String, expectedHeadRevisionId: String) async throws -> ArtifactProject {
        lastRevisionRequest = RevisionRequest(
            instruction: instruction,
            expectedHeadRevisionID: expectedHeadRevisionId
        )
        return revised
    }
    func revisions(id: String) async throws -> [ArtifactRevision] { generated.revisions }
    func source(revision: ArtifactRevision) async throws -> ArtifactSource { generated.source }
    func setHead(id: String, revisionId: String, expectedHeadRevisionId: String) async throws -> ArtifactProject { revised }
    func remix(id: String, revisionId: String?) async throws -> ArtifactProject {
        lastRemixRequest = RemixRequest(artifactID: id, revisionID: revisionId)
        return revised
    }
    func downloadAsset(id: String) async throws -> DownloadedAppletAsset {
        DownloadedAppletAsset(data: Data([1, 2, 3]), mediaType: "image/jpeg")
    }
    func uploadScreenshot(revisionId: String, jpeg: Data) async throws {}
    func publish(id: String, revisionId: String?) async throws -> ArtifactPublication {
        ArtifactPublication(
            slug: "class",
            url: URL(string: "https://example.test/class")!,
            title: "Artifact",
            createdAt: "2026-08-02T00:00:00Z",
            expiresAt: "2026-11-02T00:00:00Z"
        )
    }
    func revoke(slug: String) async throws {}
    func extend(slug: String, days: Int) async throws -> ArtifactPublication {
        try await publish(id: generated.id, revisionId: nil)
    }
    func uploadImage(
        _ image: PreparedAppletImage,
        alternativeText: String?,
        decorative: Bool
    ) async throws -> UploadedAppletImage {
        UploadedAppletImage(
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
        )
    }
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
