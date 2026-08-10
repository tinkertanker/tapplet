import SwiftUI

enum TappletTheme {
    // Tinkercademy's identity is coral, near-black and white. The darker
    // website coral carries interactive text contrast; bright coral remains
    // the recognisable logo colour for focus and brand punctuation.
    static let canvas = Color(red: 248 / 255, green: 246 / 255, blue: 241 / 255)
    static let surface = Color.white
    static let accent = Color(red: 189 / 255, green: 58 / 255, blue: 52 / 255)
    static let accentBright = Color(red: 240 / 255, green: 93 / 255, blue: 87 / 255)
    static let accentSoft = Color(red: 251 / 255, green: 238 / 255, blue: 237 / 255)
    static let filterSelection = Color(red: 124 / 255, green: 82 / 255, blue: 0 / 255)
    static let filterSelectionSoft = Color(red: 248 / 255, green: 236 / 255, blue: 203 / 255)
    static let secondaryActionSoft = Color(red: 236 / 255, green: 232 / 255, blue: 223 / 255)
    static let danger = Color(red: 154 / 255, green: 44 / 255, blue: 39 / 255)
    static let dangerSoft = Color(red: 251 / 255, green: 231 / 255, blue: 229 / 255)
    static let ink = Color(red: 23 / 255, green: 23 / 255, blue: 24 / 255)
    static let mutedInk = Color(red: 111 / 255, green: 109 / 255, blue: 103 / 255)
    static let border = Color(red: 223 / 255, green: 222 / 255, blue: 218 / 255)

    enum Typography {
        static let display = Font.system(.largeTitle, design: .rounded, weight: .bold)
        static let question = Font.system(.title, design: .rounded, weight: .bold)
        static let section = Font.system(.headline, design: .rounded, weight: .semibold)
        static let cardTitle = Font.system(.title3, design: .rounded, weight: .semibold)
        static let eyebrow = Font.system(.caption, design: .rounded, weight: .semibold)
        static let actionSmall = Font.system(.subheadline, design: .rounded, weight: .semibold)
    }
}

struct TappletSecondaryButtonStyle: ButtonStyle {
    enum BorderShape {
        case roundedRectangle
        case capsule
    }

    var borderShape: BorderShape = .roundedRectangle
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(TappletTheme.ink)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(
                configuration.isPressed ? TappletTheme.border : TappletTheme.secondaryActionSoft,
                in: shape
            )
            .overlay {
                shape.stroke(TappletTheme.border, lineWidth: 1)
            }
            .opacity(isEnabled ? 1 : 0.46)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }

    private var shape: AnyShape {
        switch borderShape {
        case .roundedRectangle:
            AnyShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .capsule:
            AnyShape(Capsule())
        }
    }
}

struct TappletCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(TappletTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TappletTheme.border.opacity(0.72), lineWidth: 1)
            }
            .shadow(color: TappletTheme.ink.opacity(0.055), radius: 18, y: 8)
    }
}

extension View {
    func tappletCard() -> some View {
        modifier(TappletCardModifier())
    }
}
