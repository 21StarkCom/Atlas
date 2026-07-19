import XCTest
@testable import ConsoleUI

final class ConsoleUITests: XCTestCase {
    func testIdentityLinksConsoleCore() {
        XCTAssertTrue(ConsoleUI.identity.contains("com.atlas.console"))
    }
}
