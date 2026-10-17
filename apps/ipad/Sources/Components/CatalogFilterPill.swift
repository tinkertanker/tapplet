import SwiftUI

struct CatalogFilterPill: View {
    let title: String
    let group: String
    let isSelected: Bool
    let accessibilityIdentifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.bold())
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(isSelected ? TappletTheme.filterSelection : TappletTheme.ink)
            .padding(.horizontal, 15)
            .frame(minHeight: 44)
            .background(
                isSelected ? TappletTheme.filterSelectionSoft : TappletTheme.surface,
                in: Capsule()
            )
            .overlay {
                Capsule()
                    .stroke(
                        isSelected ? TappletTheme.filterSelection.opacity(0.35) : TappletTheme.border,
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(group), \(title)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}
