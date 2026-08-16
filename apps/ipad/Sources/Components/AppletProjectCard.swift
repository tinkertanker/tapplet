import SwiftUI

struct AppletProjectCard: View {
    let project: ArtifactProject
    var primaryTitle = "Open"
    let onPrimary: () -> Void
    var primaryIsLoading = false
    var primaryIsDisabled = false
    var primaryAccessibilityHint: String? = nil
    var secondaryTitle: String? = nil
    var onSecondary: (() -> Void)? = nil
    var secondaryIsLoading: Bool = false
    var secondaryAccessibilityHint: String? = nil
    var onDelete: (() -> Void)? = nil

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(displayName(project.artifact.subject) ?? "Classroom applet")
                .font(TappletTheme.Typography.eyebrow)
                .foregroundStyle(TappletTheme.accent)

            Text(project.artifact.title)
                .font(TappletTheme.Typography.cardTitle)
                .foregroundStyle(TappletTheme.ink)
                .fixedSize(horizontal: false, vertical: true)

            Text(project.artifact.summary)
                .foregroundStyle(TappletTheme.mutedInk)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 4)
                .fixedSize(horizontal: false, vertical: true)

            if let level = displayName(project.artifact.level) {
                Label(level, systemImage: "graduationcap")
                    .font(.caption)
                    .foregroundStyle(TappletTheme.mutedInk)
            }

            Spacer(minLength: 4)

            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    actionButtons(expanded: true)
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        actionButtons(expanded: false)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        actionButtons(expanded: true)
                    }
                }
            }
        }
        .padding(20)
        .frame(
            maxWidth: .infinity,
            minHeight: dynamicTypeSize.isAccessibilitySize ? nil : 250,
            alignment: .leading
        )
        .tappletCard()
    }

    @ViewBuilder
    private func actionButtons(expanded: Bool) -> some View {
        Button(action: onPrimary) {
            HStack(spacing: 8) {
                if primaryIsLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                        .accessibilityHidden(true)
                }
                Text(primaryTitle)
            }
            .frame(maxWidth: expanded ? .infinity : nil)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(primaryIsDisabled || primaryIsLoading)
        .accessibilityHint(primaryAccessibilityHint ?? "")

        if let secondaryTitle, let onSecondary {
            Button(action: onSecondary) {
                HStack(spacing: 8) {
                    if secondaryIsLoading {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityHidden(true)
                    }
                    Text(secondaryTitle)
                }
                .frame(maxWidth: expanded ? .infinity : nil)
            }
                .buttonStyle(TappletSecondaryButtonStyle())
                .controlSize(.large)
                .disabled(secondaryIsLoading)
                .accessibilityHint(secondaryAccessibilityHint ?? "")
        }

        if let onDelete {
            Button("Delete", role: .destructive, action: onDelete)
                .controlSize(.large)
                .frame(maxWidth: expanded ? .infinity : nil)
        }
    }

    private func displayName(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        if value.caseInsensitiveCompare("other") == .orderedSame {
            return "Classroom"
        }
        return value
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .capitalized
    }
}
