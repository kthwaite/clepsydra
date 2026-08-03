import Foundation

/// Probes candidate addresses concurrently and reports which ones answer as a
/// Clepsydra server.
///
/// There is deliberately no scanning here. A tailnet cannot be enumerated from
/// an iOS app — Tailscale exposes no such API to third parties and does not
/// forward mDNS — so discovery is a sweep over addresses we already have a
/// reason to try: whatever the user connected to before, plus the local
/// development server.
public struct ServerDiscovery: Sendable {
    /// Probed in addition to the user's remembered servers.
    ///
    /// Only useful from the Simulator, where `localhost` is the host Mac. On a
    /// physical device it resolves to the phone itself and will simply not
    /// respond, which is why remembered addresses carry discovery there.
    public static let builtInCandidates: [String] = ["https://localhost:3000"]

    private let probe: @Sendable (ServerURL) async -> Bool

    /// Inject a probe. Used by tests to avoid real networking.
    public init(probe: @escaping @Sendable (ServerURL) async -> Bool) {
        self.probe = probe
    }

    /// Probe over the network, treating a successful uptime call as proof that
    /// a Clepsydra server is listening.
    ///
    /// The timeout is short because this runs against several addresses at
    /// once and most of them are expected to fail.
    public init(timeout: TimeInterval = 2) {
        self.init { server in
            do {
                try await APIClient(server: server, timeout: timeout).uptime()
                return true
            } catch {
                return false
            }
        }
    }

    /// Returns the subset of candidates that responded, in candidate order:
    /// remembered servers first, then the built-ins.
    public func discover(recents: [String]) async -> [ServerURL] {
        let candidates = Self.candidates(recents: recents)
        guard !candidates.isEmpty else { return [] }
        let probe = self.probe

        let responders = await withTaskGroup(of: (offset: Int, server: ServerURL)?.self) { group in
            for (offset, candidate) in candidates.enumerated() {
                group.addTask {
                    await probe(candidate) ? (offset, candidate) : nil
                }
            }

            var found: [(offset: Int, server: ServerURL)] = []
            for await result in group {
                if let result { found.append(result) }
            }
            return found
        }

        // Completion order is arbitrary; restore the candidate order so the
        // list the user sees is stable between sweeps.
        return responders.sorted { $0.offset < $1.offset }.map(\.server)
    }

    /// Normalizes and de-duplicates the candidate list, dropping anything that
    /// is not a usable HTTPS address rather than failing the whole sweep.
    static func candidates(recents: [String]) -> [ServerURL] {
        var seen = Set<String>()
        var ordered: [ServerURL] = []
        for raw in recents + builtInCandidates {
            guard let server = try? ServerURL(raw) else { continue }
            guard seen.insert(server.url.absoluteString).inserted else { continue }
            ordered.append(server)
        }
        return ordered
    }
}
