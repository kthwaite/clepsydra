import Foundation

@MainActor
public protocol ServerAddressStoring: AnyObject {
    var serverAddress: String? { get set }
}

@MainActor
public final class ServerAddressStore: ServerAddressStoring {
    public static let defaultKey = "clepsydra.serverAddress"

    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = ServerAddressStore.defaultKey
    ) {
        self.defaults = defaults
        self.key = key
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
}
