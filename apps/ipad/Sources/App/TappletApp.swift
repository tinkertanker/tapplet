import SwiftUI

@main
struct TappletApp: App {
    @State private var store = TappletStore()

    var body: some Scene {
        WindowGroup {
            TappletRootView(store: store)
                .tint(TappletTheme.accent)
                .preferredColorScheme(.light)
        }
    }
}
