import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ImageManagementView: View {
    let store: TappletStore
    let projectID: String
    let assetIDs: [String]
    let isMovingHead: Bool
    @State private var photo: PhotosPickerItem?
    @State private var pendingData: Data?
    @State private var description = ""
    @State private var decorative = false
    @State private var importsFile = false
    @State private var showsCamera = false
    @State private var error: String?
    // Shared with "Make this change", Undo and Restore: two changes at once would conflict on the head.
    private var isWorking: Bool { store.refiningProjectIDs.contains(projectID) || isMovingHead }

    var body: some View {
        ForEach(assetIDs, id: \.self) { assetID in
            HStack {
                Label(assetID, systemImage: "photo")
                Spacer()
                Button("Remove", role: .destructive) {
                    store.runChange(to: projectID) {
                        try await store.removeImage(assetID: assetID, projectID: projectID)
                    }
                }
                .disabled(isWorking)
            }
        }
        PhotosPicker("Choose from Photos", selection: $photo, matching: .images)
        Button("Choose a file") { importsFile = true }
        if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Take a photo") { showsCamera = true } }
        if pendingData != nil {
            TextField("Describe this image", text: $description, axis: .vertical)
            Toggle("Decorative image", isOn: $decorative)
            Button("Upload and ask Tapplet Studio to insert") { upload() }
                .disabled(isWorking || (!decorative && description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
        }
        if let error { Text(error).foregroundStyle(TappletTheme.danger) }
        Text("Images are prepared and checked on this iPad. AI review warnings do not block uploads; check flagged images before sharing.")
            .font(.footnote).foregroundStyle(.secondary)
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                // A slow photo load must not replace an image chosen after it.
                if photo == item { pendingData = data }
            }
        }
        .fileImporter(isPresented: $importsFile, allowedContentTypes: [.image]) { result in
            do { let url = try result.get(); guard url.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }; defer { url.stopAccessingSecurityScopedResource() }; pendingData = try Data(contentsOf: url); photo = nil }
            catch { self.error = error.localizedDescription }
        }
        .sheet(isPresented: $showsCamera) {
            CameraImagePicker { data in
                showsCamera = false
                if let data { pendingData = data; photo = nil }
            }
        }
    }

    private func upload() {
        guard let pendingData else { return }
        // A failure is kept in the store, like a failed change, so a reopened editor still shows it.
        let started = store.runChange(to: projectID) {
            try await store.addImage(pendingData, description: description, decorative: decorative, projectID: projectID)
            // Keep an image chosen while this one was being inserted, with its description.
            if self.pendingData == pendingData { self.pendingData = nil; description = ""; decorative = false; photo = nil }
        }
        if started { error = nil }
    }
}
