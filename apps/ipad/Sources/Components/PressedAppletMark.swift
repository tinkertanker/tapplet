import SwiftUI

/// The Pressed Applet brand mark: the slightly rectangular coral tile with
/// its dark-coral lip, mid-tap. Rotation is free per placement; the press
/// ticks keep their fixed proportional sizes (see docs/APP_ICON.md).
struct PressedAppletMark: View {
    var size: CGFloat
    var rotation: Angle = .degrees(-9)
    var showsTicks = true

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 512
            context.scaleBy(x: scale, y: scale)
            context.translateBy(x: 256, y: 269)
            context.rotate(by: rotation)
            context.translateBy(x: -256, y: -269)

            context.fill(
                Path(roundedRect: CGRect(x: 132, y: 191, width: 248, height: 187), cornerRadius: 55),
                with: .color(TappletTheme.accent)
            )
            context.fill(
                Path(roundedRect: CGRect(x: 119, y: 160, width: 274, height: 202), cornerRadius: 59),
                with: .color(TappletTheme.accentBright)
            )

            if showsTicks {
                let style = StrokeStyle(lineWidth: 24, lineCap: .round)
                var top = Path()
                top.move(to: CGPoint(x: 153, y: 120.5))
                top.addLine(to: CGPoint(x: 137.4, y: 104.9))
                top.move(to: CGPoint(x: 256, y: 116))
                top.addLine(to: CGPoint(x: 256, y: 94))
                top.move(to: CGPoint(x: 359, y: 120.5))
                top.addLine(to: CGPoint(x: 374.6, y: 104.9))
                context.stroke(top, with: .color(TappletTheme.accent.opacity(0.45)), style: style)

                var bottom = Path()
                bottom.move(to: CGPoint(x: 153, y: 410))
                bottom.addLine(to: CGPoint(x: 137.4, y: 425.6))
                bottom.move(to: CGPoint(x: 256, y: 414))
                bottom.addLine(to: CGPoint(x: 256, y: 436))
                bottom.move(to: CGPoint(x: 359, y: 410))
                bottom.addLine(to: CGPoint(x: 374.6, y: 425.6))
                context.stroke(bottom, with: .color(TappletTheme.accent.opacity(0.3)), style: style)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
