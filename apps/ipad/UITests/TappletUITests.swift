import XCTest

final class TappletUITests: XCTestCase {
    @MainActor
    func testLaunchesIntoExploreWithoutABlankCanvas() {
        let app = launchApp()
        XCTAssertTrue(app.staticTexts["Start with an example"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Rain, paved ground and drainage"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == 'Make a copy'")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == 'Preview'")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Conductor or insulator?"].exists)
        XCTAssertTrue(app.buttons["form-filter-game"].exists)
    }

    @MainActor
    func testExploreOffersBundledHTMLSeedForRemixing() {
        let app = launchApp()
        XCTAssertTrue(app.staticTexts["Rain, paved ground and drainage"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Make a copy"].exists)
    }

    @MainActor
    func testExamplePreviewRendersInPortraitAndFullScreen() {
        XCUIDevice.shared.orientation = .portrait
        let app = launchApp()
        let preview = app.buttons.matching(NSPredicate(format: "label == 'Preview'")).firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 8))
        preview.tap()

        let playerHeading = app.staticTexts["Rain, paved ground and drainage"]
        XCTAssertTrue(
            playerHeading.waitForExistence(timeout: 25),
            "The bundled HTML artifact should render, not a blank web view."
        )
        XCTAssertTrue(
            app.navigationBars.staticTexts["Rain, paved ground and drainage"].waitForExistence(timeout: 3),
            "The preview chrome should keep the full activity title readable."
        )

        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Explore"].waitForExistence(timeout: 5) || app.staticTexts["Explore"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testExploreSearchAndFiltersCanBeCleared() {
        let app = launchApp()
        let search = app.textFields["example-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 8))
        search.tap()
        search.typeText("fractions")

        XCTAssertTrue(app.staticTexts["Equivalent fractions"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["What do m and c do?"].exists)

        search.tap()
        search.typeText(" nonsense")
        XCTAssertTrue(app.staticTexts["No examples found"].waitForExistence(timeout: 3))
        app.buttons["clear-example-filters"].tap()

        XCTAssertTrue(app.staticTexts["18 examples"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["What do m and c do?"].exists)
    }

    @MainActor
    func testGuidedMakeReachesApprovalAndCreatesAProject() throws {
        let app = launchApp()
        selectSidebarItem(label: "Make", in: app)
        XCTAssertTrue(app.staticTexts["Who are you teaching?"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["starter-plan-times-tables-lightning"].exists)

        let answers = [
            "Secondary 3 Physics",
            "Explain how angle changes projectile range",
            "Move a slider, predict, then compare",
            "Use metres and Earth gravity",
            "Give an explanation after each prediction",
            "Eight minutes in pairs"
        ]

        for answer in answers {
            let textView = app.textViews["guided-answer"]
            XCTAssertTrue(textView.waitForExistence(timeout: 3))
            textView.tap()
            textView.typeText(answer)
            advanceGuidedFlow(in: app)
        }

        XCTAssertTrue(app.staticTexts["Check your answers"].waitForExistence(timeout: 5))
        app.buttons["Make my tapplet"].tap()
        XCTAssertTrue(app.buttons["Share"].waitForExistence(timeout: 8))
        let photos = app.buttons["Choose from Photos"]
        let editorForm = app.descendants(matching: .any)["tapplet-editor-form"]
        XCTAssertTrue(editorForm.waitForExistence(timeout: 3))
        for _ in 0..<3 {
            if photos.exists { break }
            editorForm.swipeUp()
        }
        XCTAssertTrue(photos.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Choose a file"].exists)
    }

    @MainActor
    func testAdvisoryWarningKeepsTheTappletAndRepromptSurfaceAvailable() {
        let app = launchApp(extraArguments: ["--ui-testing-advisory-warning"])
        selectSidebarItem(label: "Make", in: app)
        XCTAssertTrue(app.buttons["starter-plan-times-tables-lightning"].waitForExistence(timeout: 5))
        app.buttons["starter-plan-times-tables-lightning"].tap()
        XCTAssertTrue(app.staticTexts["Check your answers"].waitForExistence(timeout: 5))

        app.buttons["Make my tapplet"].tap()

        XCTAssertTrue(app.buttons["Share"].waitForExistence(timeout: 8))
        let warning = app.staticTexts["AI review flagged a possible email address. Check the content or re-prompt."]
        XCTAssertTrue(warning.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Make this change"].exists)

        app.buttons["Dismiss message"].tap()
        XCTAssertTrue(warning.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Make this change"].exists)
    }

    @MainActor
    func testAdvisoryWarningCanBeDismissedInsideTheShareSheet() {
        let app = launchApp(extraArguments: ["--ui-testing-advisory-warning"])
        selectSidebarItem(label: "Make", in: app)
        XCTAssertTrue(app.buttons["starter-plan-times-tables-lightning"].waitForExistence(timeout: 5))
        app.buttons["starter-plan-times-tables-lightning"].tap()
        XCTAssertTrue(app.staticTexts["Check your answers"].waitForExistence(timeout: 5))
        app.buttons["Make my tapplet"].tap()
        XCTAssertTrue(app.buttons["Share"].waitForExistence(timeout: 8))

        app.buttons["Share"].tap()

        let warning = app.staticTexts["AI review flagged a possible email address. Check the content or re-prompt."]
        XCTAssertTrue(warning.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Dismiss warning"].isHittable)
        app.buttons["Dismiss warning"].tap()
        XCTAssertTrue(warning.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Create student link"].exists)
    }

    @MainActor
    func testExploreGamesFilterAndUseThisPlan() {
        let app = launchApp()
        XCTAssertTrue(app.buttons["form-filter-game"].waitForExistence(timeout: 8))
        app.buttons["form-filter-game"].tap()
        XCTAssertTrue(app.staticTexts["4 examples"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Times-tables lightning"].exists)
        XCTAssertFalse(app.staticTexts["Rain, paved ground and drainage"].exists)

        app.buttons.matching(NSPredicate(format: "label == 'Preview'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["use-example-plan"].waitForExistence(timeout: 8))
        app.buttons["use-example-plan"].tap()

        XCTAssertTrue(app.staticTexts["Check your answers"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Game"].exists)
    }

    @MainActor
    func testStarterPlanFillsTheReviewCard() {
        let app = launchApp()
        selectSidebarItem(label: "Make", in: app)
        let plan = app.buttons["starter-plan-times-tables-lightning"]
        XCTAssertTrue(plan.waitForExistence(timeout: 5))
        plan.tap()
        XCTAssertTrue(app.staticTexts["Check your answers"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Primary 5 Mathematics"].exists)
        XCTAssertTrue(app.staticTexts["Game"].exists)
        XCTAssertTrue(app.staticTexts["pinned-example-plan"].exists)
    }

    @MainActor
    func testWorkshopAccessCanBeDeferred() {
        let app = launchApp(extraArguments: ["--ui-testing-registration-required"])
        XCTAssertTrue(app.staticTexts["Browse examples on this iPad"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Enter four numbers followed by eight letters, for example 1234ABCDEFGH. A hyphen is optional."].exists)
        let explore: XCUIElement = app.buttons["Explore examples"]
        XCTAssertTrue(explore.waitForExistence(timeout: 5))
        explore.tap()
        XCTAssertTrue(app.staticTexts["Start with an example"].waitForExistence(timeout: 5))
        let showSidebar = app.buttons["Show Sidebar"]
        if showSidebar.waitForExistence(timeout: 2) { showSidebar.tap() }
        XCTAssertTrue(app.staticTexts["Tapplet Studio access"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Code needed"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testWorkshopAccessExplainsAndValidatesAShortCodeWithoutClearingIt() {
        let app = launchApp(extraArguments: ["--ui-testing-registration-required"])
        let code = app.textFields["workshop-access-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        code.tap()
        code.typeText("SHORT")

        let activate = app.buttons["activate-workshop-access"]
        XCTAssertTrue(activate.isEnabled)
        activate.tap()

        XCTAssertTrue(app.staticTexts["Complete the class code"].waitForExistence(timeout: 3))
        XCTAssertEqual(code.value as? String, "SHORT")
    }

    @MainActor
    func testGuidedSuggestionAddsToWrittenAnswerAndSummaryRowsReturnToTheirQuestion() {
        let app = launchApp()
        selectSidebarItem(label: "Make", in: app)

        let answer = app.textViews["guided-answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
        answer.tap()
        answer.typeText("Secondary 3 Physics")
        app.buttons["Primary 5 Science"].tap()
        XCTAssertEqual(answer.value as? String, "Secondary 3 Physics\nPrimary 5 Science")
        advanceGuidedFlow(in: app)
        let answers = [
            "Explain projectile range",
            "Predict then compare",
            "Use metres",
            "Explain each answer",
            "Eight minutes in pairs"
        ]
        for response in answers {
            let currentAnswer = app.textViews["guided-answer"]
            XCTAssertTrue(currentAnswer.waitForExistence(timeout: 3))
            currentAnswer.tap()
            currentAnswer.typeText(response)
            advanceGuidedFlow(in: app)
        }

        XCTAssertTrue(app.staticTexts["Check your answers"].waitForExistence(timeout: 5))
        app.buttons["edit-brief-answer-1"].tap()
        XCTAssertTrue(app.staticTexts["What should they understand or be able to do?"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testMyAppletsEmptyStateOffersMakeAndExplore() {
        let app = launchApp()
        selectSidebarItem(label: "My Tapplets", in: app)
        XCTAssertTrue(app.staticTexts["Your tapplets will appear here"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Make one from a short plan, or copy an example from Explore."].exists)
        XCTAssertTrue(app.buttons["Restore tapplets"].exists)
        app.buttons["empty-start-with-example"].tap()
        XCTAssertTrue(app.staticTexts["Start with an example"].waitForExistence(timeout: 5))

        selectSidebarItem(label: "My Tapplets", in: app)
        XCTAssertTrue(app.buttons["empty-make-applet"].waitForExistence(timeout: 5))
        app.buttons["empty-make-applet"].tap()
        XCTAssertTrue(app.staticTexts["Who are you teaching?"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func selectSidebarItem(label: String, in app: XCUIApplication) {
        let item = app.staticTexts[label].firstMatch
        if !item.waitForExistence(timeout: 2) {
            let sidebarButton = app.buttons.matching(
                NSPredicate(format: "label CONTAINS[c] 'sidebar'")
            ).firstMatch
            XCTAssertTrue(sidebarButton.waitForExistence(timeout: 5))
            sidebarButton.tap()
        }
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
    }

    @MainActor
    private func advanceGuidedFlow(in app: XCUIApplication) {
        let keyboardButton = app.buttons["guided-continue-keyboard"]
        if keyboardButton.waitForExistence(timeout: 2), keyboardButton.isHittable {
            keyboardButton.tap()
            return
        }

        let bottomButton = app.buttons["guided-continue"]
        XCTAssertTrue(bottomButton.waitForExistence(timeout: 3))
        XCTAssertTrue(bottomButton.isHittable)
        bottomButton.tap()
    }

    @MainActor
    private func launchApp(extraArguments: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-reset"] + extraArguments
        app.launch()
        return app
    }
}
