import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// 取り込みの結果と、この Mac で開いたままのセッションの文
private func lastImportLinesOf(_ last: LastImport, open: OpenSessionLeft) -> [String] {
    switch last {
    case .notRun: openSessionLinesOf(open)
    case .finished(let result, let tagKindsOverLimit): importResultLinesOf(result, tagKindsOverLimit: tagKindsOverLimit)
    case .failed(let failure): [importFailureMessageOf(failure)] + openSessionLinesOf(open)
    }
}

/// ログインした直後に、この Mac の記録を取り込むかを確かめる（ADR 0020、Web の import-dialog.tsx）。
/// あとでにしても、設定のアカウントのタブから取り込める
struct ImportSheet: View {
    let importer: ImportModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch importer.prompt {
            case .idle(let records, .notRun):
                Text("この Mac の記録を取り込みますか？").font(.headline)
                Text(importPromptTextOf(Import.summaryOf(records.sessions)))
                    .accessibilityIdentifier("import.prompt")
                ForEach(openSessionLinesOf(records.open), id: \.self) { Text($0) }
                buttons(primary: "取り込む")
            case .idle(_, .finished(let result, let tagKindsOverLimit)):
                Text("取り込みました").font(.headline)
                ForEach(importResultLinesOf(result, tagKindsOverLimit: tagKindsOverLimit), id: \.self) { line in
                    Text(line).accessibilityIdentifier("import.result")
                }
                HStack {
                    Spacer()
                    Button("閉じる") { importer.prompting = false }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("import.close")
                }
            case .idle(_, .failed(let failure)):
                Text("この Mac の記録を取り込みますか？").font(.headline)
                Text(importFailureMessageOf(failure))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("import.failure")
                buttons(primary: "やり直す")
            case .running(let progress):
                Text("この Mac の記録を取り込みますか？").font(.headline)
                Text(importProgressLabelOf(progress))
                HStack {
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            case .checking, .unreadable, nil:
                EmptyView()
            }
        }
        .padding(20)
        .frame(width: 420)
        // 取り込んでいる間は閉じさせない（閉じても取り込みは続くが、終わったことがわからなくなる）
        .interactiveDismissDisabled(importer.isRunning)
    }

    private func buttons(primary: String) -> some View {
        HStack {
            Spacer()
            Button("あとで") { importer.prompting = false }
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("import.later")
            Button(primary) { Task { await importer.start() } }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("import.start")
        }
    }
}

/// 設定のアカウントのタブに出す、この Mac に残っている記録（ADR 0020）。いつでも取り込める
struct DeviceRecordsSection: View {
    let importer: ImportModel

    var body: some View {
        Section {
            switch importer.state {
            case .checking:
                ProgressView().controlSize(.small)
            case .unreadable(let message):
                Text(message).foregroundStyle(.red)
            case .running(let progress):
                LabeledContent {
                    ProgressView().controlSize(.small)
                } label: {
                    Text(importProgressLabelOf(progress))
                }
            case .idle(let records, let last):
                LabeledContent {
                    if !records.sessions.isEmpty {
                        Button(isFailed(last) ? "やり直す" : "取り込む") { Task { await importer.start() } }
                            .accessibilityIdentifier("account.import")
                    }
                } label: {
                    Text(remainingRecordsTextOf(Import.summaryOf(records.sessions)))
                        .accessibilityIdentifier("account.deviceRecords")
                }
                ForEach(lastImportLinesOf(last, open: records.open), id: \.self) { line in
                    Text(line).font(.callout).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("この Mac の記録")
        } footer: {
            Text("ログインする前にこの Mac で記録したセッションと記入です。取り込むとアカウントに移り、この Mac からは消えます。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .task { await importer.check() }
    }

    private func isFailed(_ last: LastImport) -> Bool {
        if case .failed = last { return true }
        return false
    }
}
