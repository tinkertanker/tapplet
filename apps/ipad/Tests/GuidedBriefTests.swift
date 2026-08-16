import XCTest
@testable import Tapplet

final class GuidedBriefTests: XCTestCase {
    func testLaterPlaceholdersStaySubjectNeutral() {
        let placeholders = BriefQuestion.all.map(\.placeholder).joined(separator: "\n")

        XCTAssertFalse(placeholders.contains("projectile"))
        XCTAssertFalse(placeholders.contains("Earth gravity"))
        XCTAssertEqual(
            BriefQuestion.all[1].placeholder,
            "Explain a key idea in their own words"
        )
        XCTAssertEqual(
            BriefQuestion.all[3].placeholder,
            "Use the terms and examples from this lesson"
        )
    }
}
