import SwiftUI

struct PageHeader: View {
    let title: String
    let subtitle: String
    var sticker: TKRobotSticker? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .center, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(TappletTheme.Typography.display)
                    .foregroundStyle(TappletTheme.ink)
                Text(subtitle)
                    .font(.body)
                    .foregroundStyle(TappletTheme.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
                Capsule()
                    .fill(TappletTheme.accentBright)
                    .frame(width: 42, height: 5)
                    .padding(.top, 4)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let sticker, !dynamicTypeSize.isAccessibilitySize {
                TKRobotStickerView(
                    sticker: sticker,
                    size: 112,
                    rotation: .degrees(-4)
                )
            }
        }
        .frame(maxWidth: 760, alignment: .leading)
    }
}
