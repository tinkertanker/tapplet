import MessageUI
import SwiftUI
import UIKit

struct FeedbackAttachment: Sendable {
    var data: Data
    var mimeType: String
    var fileName: String
}

enum FeedbackMail {
    static let recipient = "hello@tinkertanker.com"
    static let subject = "Tapplet Studio feedback"

    static var canCompose: Bool { MFMailComposeViewController.canSendMail() }

    static var body: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        return "\n\n---\nTapplet Studio \(version) (\(build)), iPadOS \(UIDevice.current.systemVersion)"
    }

    /// Fallback when Mail is not configured; cannot carry attachments.
    static var mailtoURL: URL {
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = recipient
        components.queryItems = [
            URLQueryItem(name: "subject", value: subject),
            URLQueryItem(name: "body", value: body),
        ]
        return components.url ?? URL(string: "mailto:\(recipient)")!
    }

    @MainActor
    static func screenshot() -> FeedbackAttachment? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        guard let window else { return nil }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        guard let data = image.pngData() else { return nil }
        return FeedbackAttachment(data: data, mimeType: "image/png", fileName: "screenshot.png")
    }
}

struct FeedbackMailView: UIViewControllerRepresentable {
    var attachments: [FeedbackAttachment]
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let controller = MFMailComposeViewController()
        controller.mailComposeDelegate = context.coordinator
        controller.setToRecipients([FeedbackMail.recipient])
        controller.setSubject(FeedbackMail.subject)
        controller.setMessageBody(FeedbackMail.body, isHTML: false)
        for attachment in attachments {
            controller.addAttachmentData(attachment.data, mimeType: attachment.mimeType, fileName: attachment.fileName)
        }
        return controller
    }

    func updateUIViewController(_ controller: MFMailComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: dismiss) }

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        let dismiss: DismissAction
        init(dismiss: DismissAction) { self.dismiss = dismiss }

        func mailComposeController(
            _ controller: MFMailComposeViewController,
            didFinishWith result: MFMailComposeResult,
            error: Error?
        ) {
            dismiss()
        }
    }
}
