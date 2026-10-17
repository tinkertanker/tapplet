import SwiftUI

struct StudentPreviewView: View {
    let project: ArtifactProject
    var onUsePlan: (() -> Void)? = nil
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationStack {
            AppletPreviewWebView(source: project.source, localAssets: project.localAssets)
                .navigationTitle(project.artifact.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Text(project.artifact.title)
                            .font(.headline)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                            .frame(maxWidth: 420)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if onUsePlan != nil {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Use this plan") {
                                onUsePlan?()
                                dismiss()
                            }
                            .accessibilityIdentifier("use-example-plan")
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
