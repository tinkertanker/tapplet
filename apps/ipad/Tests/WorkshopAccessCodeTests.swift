import XCTest
@testable import Tapplet

final class WorkshopAccessCodeTests: XCTestCase {
    func testAcceptsCompactAndHyphenatedLowercaseCodesAfterNormalization() {
        XCTAssertTrue(WorkshopAccessCodeValidator.isComplete("000042"))
        XCTAssertTrue(WorkshopAccessCodeValidator.isComplete(" 000-042\n"))
        XCTAssertTrue(WorkshopAccessCodeValidator.isComplete(" cde-fgh\n"))
        XCTAssertTrue(WorkshopAccessCodeValidator.isComplete("1234ABCDEFGH"))
        XCTAssertTrue(WorkshopAccessCodeValidator.isComplete(" 1234-abcd-efgh\n"))
        XCTAssertEqual(
            WorkshopAccessCodeValidator.normalizedCode(" 1234-abcd-efgh\n"),
            "1234ABCDEFGH"
        )
    }

    func testRejectsUnicodeDigitsAndLetters() {
        XCTAssertFalse(WorkshopAccessCodeValidator.isComplete("١٢٣٤٥٦"))
        XCTAssertFalse(WorkshopAccessCodeValidator.isComplete("abcſgh"))
        XCTAssertFalse(WorkshopAccessCodeValidator.isComplete("١٢٣٤ABCDEFGH"))
        XCTAssertFalse(WorkshopAccessCodeValidator.isComplete("1234ＡＢＣＤＥＦＧＨ"))
        XCTAssertFalse(WorkshopAccessCodeValidator.isComplete("1234abcdeſgh"))
    }

    func testRejectsLegacyFourLetterAndMalformedCodes() {
        for code in [
            "12345",
            "1234567",
            "AB12CD",
            "1234ABCD",
            "1234-ABCD",
            "12345ABCDEFGH",
            "1234ABCDEFG",
            "ABCD1234EFGH",
            "1234ABC-DEFGH!"
        ] {
            XCTAssertFalse(WorkshopAccessCodeValidator.isComplete(code), code)
        }
    }
}
