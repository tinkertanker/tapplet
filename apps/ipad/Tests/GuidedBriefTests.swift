import XCTest
@testable import Tapplet

final class GuidedBriefTests: XCTestCase {
    func testReviewRejectsOverlongAnswersWithoutDiscardingThem() {
        let limits = [300, 600, 600, 4000, 1000, 1000]
        for (index, limit) in limits.enumerated() {
            var draft = StarterPlan.all[0].draft
            // The API counts UTF-16 units, not Swift grapheme clusters.
            let boundary = String(repeating: "😀", count: limit / 2)
            draft.setAnswer(boundary, at: index)
            XCTAssertTrue(draft.isReadyForReview)
            draft.setAnswer(boundary + "x", at: index)
            XCTAssertFalse(draft.isReadyForReview, "Question \(index) must enforce the API limit")
            XCTAssertEqual(draft.answer(at: index), boundary + "x")
            draft.setAnswer("\u{FEFF} \n" + boundary + "\u{3000}", at: index)
            XCTAssertTrue(draft.isReadyForReview, "Trim the same whitespace as the API")
            draft.setAnswer(boundary + "\u{0085}", at: index)
            XCTAssertFalse(draft.isReadyForReview, "JavaScript does not trim NEXT LINE")
        }
        var maximum = GuidedBriefDraft()
        for (index, limit) in limits.enumerated() {
            maximum.setAnswer(String(repeating: "中", count: limit), at: index)
        }
        XCTAssertTrue(maximum.isReadyForReview, "All six maximum-length answers must fit the combined brief")
        XCTAssertLessThanOrEqual(maximum.creationBrief.utf16.count, 8000)
    }

    func testReviewNeedsEveryRequiredAnswerButNotSourceContent() throws {
        XCTAssertFalse(GuidedBriefDraft().isReadyForReview)
        var draft = try XCTUnwrap(StarterPlan.all.first).draft
        draft.sourceContent = ""
        XCTAssertTrue(draft.isReadyForReview)

        for question in BriefQuestion.all where !question.isOptional {
            var incomplete = draft
            incomplete.setAnswer(" \n ", at: question.id)
            XCTAssertFalse(incomplete.isReadyForReview, question.prompt)
            incomplete.setAnswer("Updated answer", at: question.id)
            XCTAssertTrue(incomplete.isReadyForReview, question.prompt)
        }
    }

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

    func testSuggestionsAreAddedOnceOnTheirOwnLine() {
        XCTAssertEqual(" \n".addingSuggestion("Add a timer"), "Add a timer")
        XCTAssertEqual("Make it harder".addingSuggestion("Add a timer"), "Make it harder\nAdd a timer")
        XCTAssertEqual("Make it harder\n".addingSuggestion("Add a timer"), "Make it harder\nAdd a timer")
        XCTAssertEqual("Add a timer".addingSuggestion("Add a timer"), "Add a timer")
    }
}
