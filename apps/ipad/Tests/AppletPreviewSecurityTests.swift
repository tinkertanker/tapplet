import XCTest
@testable import Tapplet

final class AppletPreviewSecurityTests: XCTestCase {
    func testOfflineRuleListBlocksEveryLoadThenAllowsOnlyLocalSchemes() throws {
        let data = try XCTUnwrap(PreviewContentSecurity.encodedRules.data(using: .utf8))
        let rules = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let blockTrigger = try XCTUnwrap(rules[0]["trigger"] as? [String: Any])
        let blockAction = try XCTUnwrap(rules[0]["action"] as? [String: Any])
        let localTrigger = try XCTUnwrap(rules[1]["trigger"] as? [String: Any])
        let localAction = try XCTUnwrap(rules[1]["action"] as? [String: Any])

        XCTAssertEqual(rules.count, 2)
        XCTAssertEqual(blockTrigger["url-filter"] as? String, ".*")
        XCTAssertEqual(blockAction["type"] as? String, "block")
        XCTAssertEqual(localAction["type"] as? String, "ignore-previous-rules")
        let localFilter = try XCTUnwrap(localTrigger["url-filter"] as? String)
        for scheme in ["about:blank", "tapplet-preview://preview/", "data:", "blob:"] {
            XCTAssertTrue(localFilter.contains(scheme))
        }
        for externalScheme in ["http:", "https:", "ws:", "wss:", "ftp:"] {
            XCTAssertFalse(localFilter.contains(externalScheme))
        }
    }

    func testProtectionReadinessFailsClosedUntilRuleListIsInstalled() {
        XCTAssertFalse(PreviewProtectionReadiness.compiling.permitsLoading)
        XCTAssertTrue(PreviewProtectionReadiness.installed.permitsLoading)
        XCTAssertFalse(PreviewProtectionReadiness.failed("compile failed").permitsLoading)
    }

    @MainActor
    func testNavigationPolicyOnlyAllowsInitialManagedMainFrameNavigation() throws {
        let managed = try XCTUnwrap(URL(string: "tapplet-preview://preview/"))
        let external = try XCTUnwrap(URL(string: "https://example.com/collect"))

        XCTAssertTrue(PreviewContentSecurity.allowsNavigation(to: managed, isMainFrame: true, isFormSubmission: false))
        XCTAssertTrue(PreviewContentSecurity.allowsNavigation(to: URL(string: "about:blank"), isMainFrame: true, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: external, isMainFrame: true, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: URL(string: "tapplet-preview://other/"), isMainFrame: true, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: managed, isMainFrame: false, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: managed, isMainFrame: true, isFormSubmission: true))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: nil, isMainFrame: true, isFormSubmission: false))
    }
}
