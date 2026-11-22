// swift-tools-version: 6.2
import PackageDescription

// 依存の向きは Web と同じ（AGENTS.md の3章、ADR 0028）。
// NanaichiDomain は何も import しない。NanaichiWorkflows はドメインだけを、
// NanaichiDevice（この端末の記録先）はドメインとワークフローと GRDB を使う。
// NanaichiPresentation（画面の文言・ボタンの並び・通知の予約）はドメインだけを使い、画面から判断を外に出す
// NanaichiAccount（アカウントの記録先とログイン）はドメインと Foundation の URLSession だけを使う
// NanaichiWatchLink（Watch と iPhone のあいだで送るもの、ADR 0031）はドメインと画面の文言を使い、記録先は契約（Backend）だけを知る
let package = Package(
    name: "NanaichiKit",
    platforms: [.macOS(.v26), .iOS(.v26), .watchOS(.v26)],
    products: [
        .library(name: "NanaichiDomain", targets: ["NanaichiDomain"]),
        .library(name: "NanaichiWorkflows", targets: ["NanaichiWorkflows"]),
        .library(name: "NanaichiDevice", targets: ["NanaichiDevice"]),
        .library(name: "NanaichiPresentation", targets: ["NanaichiPresentation"]),
        .library(name: "NanaichiAccount", targets: ["NanaichiAccount"]),
        .library(name: "NanaichiWatchLink", targets: ["NanaichiWatchLink"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift", exact: "7.11.1")
    ],
    targets: [
        .target(name: "NanaichiDomain"),
        .target(name: "NanaichiWorkflows", dependencies: ["NanaichiDomain"]),
        .target(
            name: "NanaichiDevice",
            dependencies: ["NanaichiDomain", "NanaichiWorkflows", .product(name: "GRDB", package: "GRDB.swift")]),
        .target(name: "NanaichiPresentation", dependencies: ["NanaichiDomain"]),
        .target(name: "NanaichiAccount", dependencies: ["NanaichiDomain"]),
        .target(name: "NanaichiWatchLink", dependencies: ["NanaichiDomain", "NanaichiPresentation"]),
        // 応答の例（Fixtures）はゴールデンケースと同じくファイルのパスから読むので、リソースにしない
        .testTarget(name: "NanaichiDomainTests", dependencies: ["NanaichiDomain"], exclude: ["Fixtures"]),
        .testTarget(
            name: "NanaichiDeviceTests",
            dependencies: [
                "NanaichiDomain", "NanaichiWorkflows", "NanaichiDevice",
                .product(name: "GRDB", package: "GRDB.swift"),
            ]),
        .testTarget(name: "NanaichiPresentationTests", dependencies: ["NanaichiDomain", "NanaichiPresentation"]),
        .testTarget(name: "NanaichiAccountTests", dependencies: ["NanaichiDomain", "NanaichiAccount"]),
        // iPhone が Watch の頼みを通す先は、この端末の記録先（メモリ）で確かめる
        .testTarget(
            name: "NanaichiWatchLinkTests",
            dependencies: ["NanaichiDomain", "NanaichiPresentation", "NanaichiDevice", "NanaichiWatchLink"]),
    ]
)
