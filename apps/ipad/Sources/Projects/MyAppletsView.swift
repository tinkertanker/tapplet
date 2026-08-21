import SwiftUI

struct MyAppletsView: View {
    let store: TappletStore
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header

                if store.projects.isEmpty {
                    emptyState
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280))], spacing: 18) {
                        ForEach(store.projects.sorted { $0.updatedAt > $1.updatedAt }) { project in
                            AppletProjectCard(
                                project: project,
                                onPrimary: { store.open(project) },
                                onDelete: {
                                    Task {
                                        do { try await store.deleteProject(projectID: project.id) }
                                        catch { self.error = error.localizedDescription }
                                    }
                                }
                            )
                        }
                    }
                }
            }
            .padding(32)
        }
        .alert(
            "Tapplet Studio could not complete this action",
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

    @ViewBuilder
    private var header: some View {
        if dynamicTypeSize.isAccessibilitySize || store.projects.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                PageHeader(
                    title: "My Tapplets",
                    subtitle: "Copies and tapplets you make stay on this iPad so you can preview them offline.",
                    sticker: store.projects.isEmpty ? .happy : nil
                )
                if !store.projects.isEmpty {
                    headerActions(expanded: true)
                }
            }
        } else {
            HStack(alignment: .top, spacing: 16) {
                PageHeader(
                    title: "My Tapplets",
                    subtitle: "Copies and tapplets you make stay on this iPad so you can preview them offline."
                )
                Spacer(minLength: 12)
                headerActions(expanded: false)
            }
        }
    }

    @ViewBuilder
    private func headerActions(expanded: Bool) -> some View {
        if expanded {
            VStack(alignment: .leading, spacing: 10) {
                restoreButton
                    .frame(maxWidth: .infinity)
                makeButton
                    .frame(maxWidth: .infinity)
            }
        } else {
            HStack(spacing: 10) {
                restoreButton
                makeButton
            }
        }
    }

    private var makeButton: some View {
        Button("Make a tapplet") { store.selectedSection = .make }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("my-applets-make")
    }

    private var restoreButton: some View {
        Button {
            restoreApplets()
        } label: {
            HStack(spacing: 8) {
                if store.isRestoringFromTapplet {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityHidden(true)
                }
                Text(store.isRestoringFromTapplet ? "Restoring…" : "Restore tapplets")
            }
        }
        .buttonStyle(.plain)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(TappletTheme.accent)
        .frame(minHeight: 44)
        .disabled(store.isRestoringFromTapplet)
        .accessibilityIdentifier("restore-applets")
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            PressedAppletMark(size: 72)
            Text("Your tapplets will appear here")
                .font(TappletTheme.Typography.question)
                .foregroundStyle(TappletTheme.ink)
                .multilineTextAlignment(.center)
            Text("Make one from a short plan, or copy an example from Explore.")
                .foregroundStyle(TappletTheme.mutedInk)
                .multilineTextAlignment(.center)
            Button("Make a tapplet") { store.selectedSection = .make }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("empty-make-applet")
            Button("Start with an example") { store.selectedSection = .explore }
                .buttonStyle(TappletSecondaryButtonStyle())
                .controlSize(.large)
                .accessibilityIdentifier("empty-start-with-example")
            restoreButton
        }
        .frame(maxWidth: .infinity)
        .padding(28)
        .tappletCard()
        .padding(.top, 8)
    }

    private func restoreApplets() {
        Task {
            do { _ = try await store.restoreFromTapplet() }
            catch { self.error = error.localizedDescription }
        }
    }
}
