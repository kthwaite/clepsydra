import Foundation

@MainActor
public protocol ServerAddressStoring: AnyObject {
    var serverAddress: String? { get set }
    /// Previously connected servers, most recent first.
    var recentAddresses: [String] { get set }
}

public extension ServerAddressStoring {
    /// Records a successful connection, newest first and without duplicates.
    ///
    /// Lives on the protocol so the ordering and cap behave identically for
    /// the real store and for test doubles.
    func remember(_ address: String) {
        var next = recentAddresses.filter { $0 != address }
        next.insert(address, at: 0)
        recentAddresses = Array(next.prefix(ServerAddressStore.maxRecents))
    }
}

@MainActor
public final class ServerAddressStore: ServerAddressStoring {
    public static let defaultKey = "clepsydra.serverAddress"
    public static let defaultRecentsKey = "clepsydra.recentServerAddresses"
    /// Enough to cover a laptop, a desktop and a couple of tailnet hosts
    /// without turning the setup screen into a list to scroll.
    public static let maxRecents = 5

    private let defaults: UserDefaults
    private let key: String
    private let recentsKey: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = ServerAddressStore.defaultKey,
        recentsKey: String = ServerAddressStore.defaultRecentsKey
    ) {
        self.defaults = defaults
        self.key = key
        self.recentsKey = recentsKey
    }

    public var serverAddress: String? {
        get { defaults.string(forKey: key) }
        set {
            if let newValue {
                defaults.set(newValue, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
    }

    public var recentAddresses: [String] {
        get {
            if let stored = defaults.stringArray(forKey: recentsKey) {
                return stored
            }
            // An install predating the recents list still has a single saved
            // address; surface it rather than presenting an empty list.
            return serverAddress.map { [$0] } ?? []
        }
        set { defaults.set(newValue, forKey: recentsKey) }
    }
}
