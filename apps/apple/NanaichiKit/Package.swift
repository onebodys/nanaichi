// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "NanaichiKit",
    platforms: [.macOS(.v26), .iOS(.v26), .watchOS(.v26)],
    products: [
        .library(name: "NanaichiDomain", targets: ["NanaichiDomain"]),
    ],
    targets: [
        .target(name: "NanaichiDomain"),
        .testTarget(name: "NanaichiDomainTests", dependencies: ["NanaichiDomain"]),
    ]
)
