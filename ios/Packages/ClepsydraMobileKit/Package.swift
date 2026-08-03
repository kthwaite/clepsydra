// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ClepsydraMobileKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ClepsydraCore", targets: ["ClepsydraCore"]),
        .library(name: "ClepsydraUI", targets: ["ClepsydraUI"]),
    ],
    targets: [
        .target(name: "ClepsydraCore"),
        .target(
            name: "ClepsydraUI",
            dependencies: ["ClepsydraCore"]
        ),
        .testTarget(name: "ClepsydraCoreTests", dependencies: ["ClepsydraCore"]),
        .testTarget(name: "ClepsydraUITests", dependencies: ["ClepsydraUI"]),
    ]
)
