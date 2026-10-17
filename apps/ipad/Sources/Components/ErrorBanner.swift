import SwiftUI

/// An inline failure with its title and message, shown in place of the action that failed.
struct ErrorBanner: View {
    let presentation: TappletErrorPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(presentation.title, systemImage: "exclamationmark.triangle.fill")
                .font(.callout.weight(.semibold))
            Text(presentation.message)
                .font(.callout)
        }
        .foregroundStyle(TappletTheme.danger)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TappletTheme.dangerSoft, in: RoundedRectangle(cornerRadius: 12))
    }
}
