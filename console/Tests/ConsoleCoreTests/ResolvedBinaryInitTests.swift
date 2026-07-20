import XCTest
@testable import ConsoleCore

// P6 (revision) — the ResolvedBinary initializer enforces the resolver's structural invariants, so no
// caller (production OR fixture) can mint an empty/relative launch or pair a binary with a foreign
// checkout's schemas (the previously-structural probe/binding invariants).
final class ResolvedBinaryInitTests: XCTestCase {

    func testEmptyLaunchRejected() throws {
        let bundle = try TestSupport.realBundle()
        XCTAssertThrowsError(try ResolvedBinary(launch: [], contractAnchor: bundle.checkoutRoot,
                                                baseEnv: [:], bundle: bundle)) { error in
            XCTAssertEqual(error as? ResolvedBinaryError, .emptyLaunch)
        }
    }

    func testRelativeLaunchRejected() throws {
        let bundle = try TestSupport.realBundle()
        XCTAssertThrowsError(try ResolvedBinary(launch: ["brain"], contractAnchor: bundle.checkoutRoot,
                                                baseEnv: [:], bundle: bundle)) { error in
            XCTAssertEqual(error as? ResolvedBinaryError, .relativeLaunch("brain"))
        }
    }

    func testCrossCheckoutAnchorRejected() throws {
        let bundle = try TestSupport.realBundle()
        // An anchor OUTSIDE the bound bundle's checkout — a binary paired with another checkout's schemas.
        let foreign = URL(fileURLWithPath: "/tmp/some-other-checkout/apps/cli/dist/bin.js")
        XCTAssertThrowsError(try ResolvedBinary(launch: ["/usr/bin/true"], contractAnchor: foreign,
                                                baseEnv: [:], bundle: bundle)) { error in
            guard case .anchorOutsideCheckout = (error as? ResolvedBinaryError) else {
                return XCTFail("expected anchorOutsideCheckout, got \(error)")
            }
        }
    }

    func testInCheckoutAnchorAccepted() throws {
        let bundle = try TestSupport.realBundle()
        let anchor = bundle.checkoutRoot.appendingPathComponent("apps/cli/dist/bin.js")
        XCTAssertNoThrow(try ResolvedBinary(launch: ["/usr/bin/true"], contractAnchor: anchor,
                                            baseEnv: [:], bundle: bundle))
    }
}
