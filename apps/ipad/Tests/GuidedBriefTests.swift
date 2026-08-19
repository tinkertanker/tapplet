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
            BriefQuestion.all[2].placeholder,
            "Choose, predict, then compare what happens"
        )
        XCTAssertEqual(
            BriefQuestion.all[3].placeholder,
            "Use the terms and examples from this lesson"
        )
        XCTAssertFalse(BriefQuestion.all[2].supportingText.contains("format later"))
        XCTAssertTrue(BriefQuestion.all[2].suggestions.contains("Keep a streak going"))
        XCTAssertEqual(StarterPlan.all.count, 8)
        XCTAssertEqual(TappletSection.myApplets.title, "My Tapplets")
        XCTAssertEqual(StarterPlan.matching(exampleID: "times-tables-lightning")?.form, .game)
        XCTAssertEqual(
            StarterPlan.matching(exampleRevisionID: "times-tables-lightning-seed")?.id,
            "times-tables-lightning"
        )
        XCTAssertEqual(ActivityFormat.allCases.map(\.rawValue), ["game", "quiz", "simulation", "practice"])
        XCTAssertEqual(RefineSuggestion.all.map(\.id), ["timer", "lives", "streak", "explain", "harder", "bigger"])
    }
}
