import XCTest
import UIKit
@testable import Tapplet

final class CameraImagePickerTests: XCTestCase {
    @MainActor
    func testCancellationDismissesPickerNotJustCallsBack() {
        let picker = DismissalSpyPicker()
        var callbacks = 0
        let coordinator = CameraImagePicker(onImage: { data in
            callbacks += 1
            XCTAssertNil(data)
        }).makeCoordinator()

        coordinator.imagePickerControllerDidCancel(picker)

        XCTAssertEqual(callbacks, 1)
        XCTAssertTrue(picker.dismissWasRequested, "Cancel must dismiss the picker, not merely deliver nil")
    }

    @MainActor
    func testSuccessfulCaptureDismissesPickerNotJustCallsBack() {
        let picker = DismissalSpyPicker()
        var result: Data?
        let coordinator = CameraImagePicker(onImage: { result = $0 }).makeCoordinator()
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        }

        coordinator.imagePickerController(picker, didFinishPickingMediaWithInfo: [.originalImage: image])

        XCTAssertNotNil(result.flatMap { UIImage(data: $0) })
        XCTAssertTrue(picker.dismissWasRequested, "Use Photo must dismiss the picker after delivering the image")
    }
}

@MainActor
private final class DismissalSpyPicker: UIImagePickerController {
    private(set) var dismissWasRequested = false

    override func dismiss(animated flag: Bool, completion: (() -> Void)? = nil) {
        dismissWasRequested = true
        completion?()
    }
}
