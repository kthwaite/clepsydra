import ClepsydraCore
import XCTest

final class ServerDiscoveryTests: XCTestCase {
    func testReturnsOnlyCandidatesThatRespond() async {
        let discovery = ServerDiscovery { server in
            server.url.absoluteString == "https://awake.example"
        }

        let found = await discovery.discover(
            recents: ["https://awake.example", "https://asleep.example"]
        )

        XCTAssertEqual(found.map(\.url.absoluteString), ["https://awake.example"])
    }

    func testOrdersRecentsAheadOfTheBuiltInLocalhostCandidate() async {
        let discovery = ServerDiscovery { _ in true }

        let found = await discovery.discover(recents: ["https://remembered.example"])

        XCTAssertEqual(
            found.map(\.url.absoluteString),
            ["https://remembered.example", "https://localhost:3000"]
        )
    }

    func testProbesEachDistinctAddressOnlyOnce() async {
        let recorder = ProbeRecorder()
        let discovery = ServerDiscovery { server in
            await recorder.record(server.url.absoluteString)
            return false
        }

        // The same host in three spellings, plus a duplicate of the built-in
        // localhost candidate: normalization should collapse all of them.
        _ = await discovery.discover(recents: [
            "https://dupe.example",
            "  https://dupe.example/  ",
            "HTTPS://dupe.example",
            "https://localhost:3000"
        ])

        let probed = await recorder.probed
        XCTAssertEqual(probed.filter { $0 == "https://dupe.example" }.count, 1)
        XCTAssertEqual(probed.filter { $0 == "https://localhost:3000" }.count, 1)
    }

    func testSkipsMalformedRecentsWithoutFailingTheSweep() async {
        let discovery = ServerDiscovery { _ in true }

        let found = await discovery.discover(recents: [
            "not a URL",
            "http://insecure.example",
            "https://valid.example"
        ])

        // The malformed and plain-HTTP entries are dropped rather than probed;
        // HTTPS-only is the transport contract the client is built around.
        XCTAssertEqual(
            found.map(\.url.absoluteString),
            ["https://valid.example", "https://localhost:3000"]
        )
    }

    func testProbesRunConcurrentlyRatherThanOneAfterAnother() async {
        let tracker = ConcurrencyTracker()
        let discovery = ServerDiscovery { _ in
            await tracker.enter()
            // Give the scheduler room to start the sibling probes before this
            // one finishes; serial execution would keep the peak at 1.
            for _ in 0..<20 { await Task.yield() }
            await tracker.leave()
            return false
        }

        _ = await discovery.discover(recents: [
            "https://one.example",
            "https://two.example",
            "https://three.example"
        ])

        let peak = await tracker.peak
        XCTAssertGreaterThan(peak, 1, "probes should overlap, peak concurrency was \(peak)")
    }

    func testAnEmptyRecentListStillProbesLocalhost() async {
        let discovery = ServerDiscovery { _ in true }

        let found = await discovery.discover(recents: [])

        XCTAssertEqual(found.map(\.url.absoluteString), ["https://localhost:3000"])
    }
}

private actor ProbeRecorder {
    private(set) var probed: [String] = []

    func record(_ address: String) {
        probed.append(address)
    }
}

private actor ConcurrencyTracker {
    private var active = 0
    private(set) var peak = 0

    func enter() {
        active += 1
        peak = max(peak, active)
    }

    func leave() {
        active -= 1
    }
}
