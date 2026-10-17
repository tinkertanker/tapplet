import CoreImage.CIFilterBuiltins
import SwiftUI

struct ShareArtifactView: View {
    let store: TappletStore
    let projectID: String
    let onAccessRequired: (TappletAPIError) -> Void
    @Environment(\.dismiss) var dismiss
    @State private var working = false
    @State private var error: String?

    var project: ArtifactProject? { store.projects.first { $0.id == projectID } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if let advisory = store.advisoryNotice {
                        HStack(spacing: 12) {
                            Label(advisory, systemImage: "exclamationmark.triangle.fill")
                            Button {
                                store.advisoryNotice = nil
                            } label: {
                                Image(systemName: "xmark").frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Dismiss warning")
                        }
                        .foregroundStyle(TappletTheme.ink)
                        .padding()
                        .background(TappletTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("advisory-warning")
                    }
                    Text("Published tapplets can currently be used as examples for future generation. Turning off the student link also removes this revision from that example pool.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("publication-generation-context-notice")
                    if let publication = project?.artifact.publication,
                       publication.revokedAt == nil, !publication.isExpired() {
                        if project?.artifact.publicationStale == true {
                            Text("Students still see the earlier version. Update the link to share your latest changes.")
                                .accessibilityIdentifier("publication-stale-notice")
                            Button("Update student link") { perform { _ = try await store.publish(projectID: projectID) } }
                                .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("update-student-link")
                        }
                        if let qr = qrCode(publication.url) {
                            Image(uiImage: qr)
                                .interpolation(.none)
                                .resizable()
                                .frame(width: 220, height: 220)
                                .accessibilityLabel("QR code for student link")
                        }
                        Text(publication.url.absoluteString).textSelection(.enabled)
                        ShareLink(item: publication.url)
                        Text("Expires \(publication.formattedExpirationDate())")
                        Button("Extend 90 days") { perform { try await store.extendPublication(projectID: projectID) } }
                        Button("Turn off link", role: .destructive) { perform { try await store.unpublish(projectID: projectID) } }
                    } else {
                        PressedAppletMark(size: 72, rotation: .degrees(12))
                        if let publication = project?.artifact.publication {
                            Text(publication.revokedAt != nil ? "The student link is turned off." : "The student link has expired.")
                        }
                        Button("Create student link") { perform { _ = try await store.publish(projectID: projectID) } }
                            .buttonStyle(.borderedProminent)
                    }
                    if let error { Text(error).foregroundStyle(TappletTheme.danger) }
                }
                .disabled(working)
                .padding()
            }
            .navigationTitle("Share with students")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                try await operation()
            } catch let error as TappletAPIError where error.requiresRegistration {
                onAccessRequired(error)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
    private func qrCode(_ url: URL) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(url.absoluteString.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let image = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}
