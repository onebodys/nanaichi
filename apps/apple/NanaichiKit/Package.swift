// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "NanaichiKit",
    platforms: [.macOS(.v26), .iOS(.v26), .watchOS(.v26)],
    products: [
        .library(name: "NanaichiDomain", targets: ["NanaichiDomain"])
    ],
    targets: [
        .target(name: "NanaichiDomain"),
        // 応答の例（Fixtures）はゴールデンケースと同じくファイルのパスから読むので、リソースにしない
        .testTarget(name: "NanaichiDomainTests", dependencies: ["NanaichiDomain"], exclude: ["Fixtures"]),
    ]
)
