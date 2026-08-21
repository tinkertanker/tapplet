import SwiftUI

enum WorkshopAccessCodeValidator {
    static func normalizedCode(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .replacingOccurrences(of: "-", with: "")
    }

    static func isComplete(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.allSatisfy({ byte in
            byte == 45 || (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
        }) else { return false }
        let bytes = Array(normalizedCode(value).utf8)
        guard bytes.count == 12 else { return false }
        return bytes[..<4].allSatisfy { (48...57).contains($0) }
            && bytes[4...].allSatisfy { (65...90).contains($0) }
    }
}

struct WorkshopAccessView: View {
    let store: TappletStore

    @State private var accessCode = ""
    @State private var isRegistering = false
    @State private var registrationError: TappletErrorPresentation?
    @FocusState private var codeIsFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if store.workshopAccessState == .ready {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 52))
                            .foregroundStyle(TappletTheme.accent)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("This iPad is ready")
                                .font(.largeTitle.bold())
                            Text("You can make, share and manage tapplets here. Existing student links stay connected to this Tapplet Studio access.")
                                .foregroundStyle(TappletTheme.mutedInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else {
                        PressedAppletMark(size: 64, rotation: .degrees(-12))
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Browse examples on this iPad")
                                .font(.largeTitle.bold())
                                .fixedSize(horizontal: false, vertical: true)
                            Text("You can preview ready-made tapplets now. Enter a class code only when you want to make or share tapplets. It does not create an account, and students never need a code or account.")
                                .font(.body)
                                .foregroundStyle(TappletTheme.mutedInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Button(action: exploreExamples) {
                            HStack {
                                Spacer()
                                Text("Explore examples")
                                Spacer()
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(isRegistering)
                        .accessibilityIdentifier("explore-examples")

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Have a class code?")
                                .font(TappletTheme.Typography.section)
                                .foregroundStyle(TappletTheme.ink)

                            TextField("Class code", text: $accessCode)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled()
                                .font(.title3.monospaced().weight(.semibold))
                                .padding(14)
                                .background(TappletTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                                .focused($codeIsFocused)
                                .accessibilityIdentifier("workshop-access-code")
                                .disabled(isRegistering)

                            Label("Enter four numbers followed by eight letters, for example 1234ABCDEFGH. A hyphen is optional.", systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(accessCodeIsTooShort ? TappletTheme.danger : TappletTheme.mutedInk)
                        }

                        if let registrationError {
                            VStack(alignment: .leading, spacing: 4) {
                                Label(registrationError.title, systemImage: "exclamationmark.triangle.fill")
                                    .font(.callout.weight(.semibold))
                                Text(registrationError.message)
                                    .font(.callout)
                            }
                            .foregroundStyle(TappletTheme.danger)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(TappletTheme.dangerSoft, in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityIdentifier("workshop-access-error")
                        }

                        Button {
                            register()
                        } label: {
                            HStack {
                                Spacer()
                                if isRegistering {
                                    ProgressView()
                                    Text("Activating…")
                                } else {
                                    Text("Activate Tapplet Studio")
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(TappletSecondaryButtonStyle())
                        .controlSize(.large)
                        .disabled(isRegistering)
                        .accessibilityIdentifier("activate-workshop-access")

                        Text("Your Tapplet Studio access stays securely on this iPad. You can explore examples without a code and activate Tapplet Studio from the sidebar whenever you are ready.")
                            .font(.footnote)
                            .foregroundStyle(TappletTheme.mutedInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)
                }
                .padding(32)
                .frame(maxWidth: 620, minHeight: 520, alignment: .topLeading)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Tapplet Studio access")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(accessDismissalTitle) {
                        if store.workshopAccessState != .ready {
                            exploreExamples()
                        } else {
                            store.dismissWorkshopAccess()
                        }
                    }
                    .disabled(isRegistering)
                }
            }
            .onChange(of: accessCode) { _, _ in
                registrationError = nil
            }
        }
        .presentationDetents([.large])
    }

    private var cleanedAccessCode: String {
        accessCode.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var accessDismissalTitle: String {
        if store.workshopAccessState == .ready { return "Done" }
        return "Not now"
    }

    private var accessCodeIsTooShort: Bool {
        // Codes are four digits plus eight letters.
        !cleanedAccessCode.isEmpty && cleanedAccessCode.count < 12
    }

    private var accessCodeIsIncomplete: Bool {
        !cleanedAccessCode.isEmpty && !WorkshopAccessCodeValidator.isComplete(cleanedAccessCode)
    }

    private func exploreExamples() {
        if store.selectedProjectID == nil {
            store.selectedSection = .explore
        }
        store.dismissWorkshopAccess()
    }

    private func register() {
        guard !isRegistering else { return }
        guard !cleanedAccessCode.isEmpty else {
            registrationError = TappletErrorPresentation(
                title: "Enter your class code",
                message: "Ask your workshop facilitator for the class code that activates Tapplet Studio on this iPad.",
                requestsWorkshopAccess: false
            )
            codeIsFocused = true
            return
        }
        guard !accessCodeIsIncomplete else {
            registrationError = TappletErrorPresentation(
                title: "Complete the class code",
                message: "Enter all four numbers and every letter of your code. Your code is still in the field above.",
                requestsWorkshopAccess: false
            )
            codeIsFocused = true
            return
        }
        isRegistering = true
        registrationError = nil
        codeIsFocused = false
        Task { @MainActor in
            defer { isRegistering = false }
            do {
                try await store.registerWorkshopAccess(accessCode)
            } catch {
                registrationError = store.present(error, during: .activation)
                codeIsFocused = true
            }
        }
    }
}
