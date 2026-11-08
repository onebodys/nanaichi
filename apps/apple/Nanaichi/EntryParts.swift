import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// タグの入力欄（GLOSSARY の「タグ」）。つけたタグを札で並べ、入力すると候補を出す（Web の tag-input.tsx）。
///
/// 候補は使っているタグを優先し、一致するものがなければ新しく作れる（`tagOptionsOf`）。
/// Return で最初のつけられる候補をつけ、札の × で外す
struct TagInput: View {
    let known: [TagName]
    let attached: [TagName]
    let onChange: ([TagName]) -> Void
    var identifier = "tags"
    @State private var query = ""

    private var options: TagOptions { tagOptionsOf(query: query, known: known, attached: attached) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "number")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                ForEach(attached, id: \.self) { name in
                    TagChip(name: name) { onChange(attached.filter { $0 != name }) }
                }
                TextField(attached.isEmpty ? "タグをつける" : "", text: $query)
                    .textFieldStyle(.plain)
                    .frame(minWidth: 90)
                    .onSubmit(attachFirst)
                    .textInputSuggestions {
                        ForEach(options.options.filter { !attached.contains($0.name) }, id: \.self) { option in
                            Text(tagOptionTextOf(option))
                                .textInputCompletion(option.attachable ? option.name.rawValue : query)
                        }
                    }
                    .accessibilityLabel("タグ")
                    .accessibilityIdentifier("\(identifier).input")
            }
            if let hint {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("\(identifier).hint")
            }
        }
    }

    private var hint: String? {
        switch options.hint {
        case .invalid: return invalidTagNameHint
        case .none:
            guard case .new(_, creatable: false)? = options.options.last, !query.isEmpty else { return nil }
            return options.options.last.map(tagOptionTextOf)
        }
    }

    private func attachFirst() {
        guard let option = options.options.first(where: \.attachable) else { return }
        if !attached.contains(option.name) { onChange(attached + [option.name]) }
        query = ""
    }
}

/// つけたタグの札。× で外す
private struct TagChip: View {
    let name: TagName
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 2) {
            Text(tagTextOf(name))
            Button(action: remove) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
            }
            .buttonStyle(.borderless)
            .help("\(tagTextOf(name)) を外す")
            .accessibilityLabel("\(tagTextOf(name)) を外す")
        }
        .font(.callout)
        .padding(.leading, 8)
        .padding(.trailing, 5)
        .padding(.vertical, 2)
        .background(.quaternary, in: Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tag.attached")
    }
}

/// 記入についたタグの表示
struct TagList: View {
    let tags: [TagName]

    var body: some View {
        if !tags.isEmpty {
            HStack(spacing: 4) {
                ForEach(tags, id: \.self) { name in
                    Text(tagTextOf(name))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 4))
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("タグ \(tags.map(tagTextOf).joined(separator: " "))")
            .accessibilityIdentifier("entry.tags")
        }
    }
}

/// 本文をプレーンテキストで出し、URL だけをリンクにする。改行はそのまま出す
struct EntryBodyText: View {
    let text: String

    var body: some View {
        Text(attributed)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("entry.body")
    }

    private var attributed: AttributedString {
        linkify(text).reduce(into: AttributedString()) { result, segment in
            switch segment {
            case .text(let text): result += AttributedString(text)
            case .link(let href):
                var link = AttributedString(href)
                link.link = URL(string: href)
                result += link
            }
        }
    }
}

/// 書いたときのタイマーの状態のバッジ。見た目は短く（`2-1 ジャーナル`）、読み上げには長い文言を使う
struct WrittenDuringBadge: View {
    let writtenDuring: WrittenDuring

    private var color: Color {
        switch writtenDuring {
        case .focus: PhaseStyle.focus.color
        case .journal: PhaseStyle.journal.color
        case .breakTime: PhaseStyle.breakTime.color
        case .idle: .secondary
        }
    }

    var body: some View {
        Text(writtenDuringBadgeOf(writtenDuring))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(color.opacity(0.14), in: Capsule())
            .accessibilityLabel(writtenDuringTextOf(writtenDuring))
    }
}

/// 記入の見出し（書いた時刻・状態・編集済み）
struct EntryHeader: View {
    let entry: JournalEntry

    var body: some View {
        HStack(spacing: 6) {
            Text(timeTextOf(entry.writtenAt, timeZone: deviceTimeZone()))
                .monospacedDigit()
            WrittenDuringBadge(writtenDuring: entry.writtenDuring)
            if isEdited(entry) { Text("編集済み") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// 読むだけの記入（スタッツのジャーナル記入の見返し）。編集・削除はタイムラインでする
struct ReadOnlyEntry: View {
    let entry: JournalEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            EntryHeader(entry: entry)
            EntryBodyText(text: entry.body.unwrap())
            TagList(tags: entry.tags)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("entry")
    }
}

/// 読み込み中・読み込めなかったときの表示。読み込めたら `content` に値を渡す
struct LoadableContent<Value, Content: View>: View {
    let loadable: Loadable<Value>
    let what: String
    let reload: () -> Void
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        switch loadable {
        case .loading:
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding()
        case .loadFailed:
            ContentUnavailableView {
                Label("\(what)を読み込めませんでした", systemImage: "exclamationmark.triangle")
            } actions: {
                Button("読み込み直す", action: reload)
            }
        case .loaded(let value):
            content(value)
        }
    }
}
