import ClepsydraUI
import XCTest

@MainActor
final class AppRootViewTests: XCTestCase {
    func testRootViewCanBeConstructed() {
        _ = AppRootView()
    }
}
