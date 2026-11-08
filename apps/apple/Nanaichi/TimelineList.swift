import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// ジャーナル記入の入力欄の下のタイムライン（docs/PRODUCT.md「画面」、Web の timeline-panel.tsx）。
/// 新しい記入が上で、日付とセッションの区切りを挟む。組み立てはドメイン（`Timeline.build`）にある。
///
/// 記入の編集はシートで、削除は確かめてから行う。どちらも記入の右クリックと「…」のメニューから選べる
struct TimelineList: View {
    let timeline: TimelineModel
    let tags: TagsModel
    let now: Instant
    @State private var editing: JournalEntry?
    @State private var deleting: JournalEntry?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                content
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .accessibilityIdentifier("timeline")
        .sheet(item: $editing) { entry in
            EntryEditor(entry: entry, known: tags.known) { body, newTags in
                await timeline.edit(entry.id, body: body, tags: newTags)
            }
        }
        .confirmationDialog(
            "この記入を削除しますか？", isPresented: deletingPresented, titleVisibility: .visible, presenting: deleting
        ) { entry in
            Button("削除", role: .destructive) { Task { await timeline.remove(entry.id) } }
                .accessibilityIdentifier("entry.confirmDelete")
            Button("やめる", role: .cancel) {}
        } message: { _ in
            Text("削除した記入は元に戻せません。")
        }
    }

    private var deletingPresented: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    @ViewBuilder
    private var content: some View {
        if let message = timeline.errorMessage {
            Text(message)
                .font(.callout)
                .foregroundStyle(.red)
                .padding(.vertical, 8)
                .accessibilityIdentifier("timeline.error")
        }
        switch timeline.days(now: now) {
        case .loading:
            ProgressView().frame(maxWidth: .infinity).padding()
        case .loadFailed:
            ContentUnavailableView {
                Label("タイムラインを読み込めませんでした", systemImage: "exclamationmark.triangle")
            } actions: {
                Button("読み込み直す", action: timeline.reload)
            }
        case .loaded(let days, let hasMore):
            if days.isEmpty {
                Text("セッションを開始すると、ここにジャーナル記入が並びます")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            }
            ForEach(days, id: \.date) { day in
                Section {
                    ForEach(day.sessions, id: \.sessionId) { daySession in
                        DaySessionView(
                            daySession: daySession, edit: { editing = $0 }, delete: { deleting = $0 })
                    }
                } header: {
                    DayHeader(day: day)
                }
            }
            if hasMore {
                Button(timeline.loadingMore ? "読み込み中…" : "さらに読み込む") {
                    Task { await timeline.loadMore() }
                }
                .disabled(timeline.loadingMore)
                .frame(maxWidth: .infinity)
                .padding(.top, 16)
                .onAppear { Task { await timeline.loadMore() } }
                .accessibilityIdentifier("timeline.loadMore")
            }
        }
    }
}

private struct DayHeader: View {
    let day: TimelineDay

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(dateTextOf(day.date))
                .font(.headline)
            Spacer()
            Text(dayCompletedSetsTextOf(day.completedSets))
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .padding(.vertical, 8)
        .background(.background)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("timeline.day")
    }
}

private struct DaySessionView: View {
    let daySession: TimelineDaySession
    let edit: (JournalEntry) -> Void
    let delete: (JournalEntry) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(daySessionTextOf(startedAt: daySession.startedAt, timeZone: deviceTimeZone()))
                if let stats = daySessionStatsOf(daySession.completedSets) {
                    Text("· \(stats)")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("timeline.session")
            Divider()
            if daySession.entries.isEmpty {
                Text("記入はありません")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 10)
            }
            ForEach(daySession.entries, id: \.id) { entry in
                EntryRow(entry: entry, edit: { edit(entry) }, delete: { delete(entry) })
                Divider()
            }
        }
        .padding(.bottom, 12)
    }
}

/// タイムラインの記入。ポインタを重ねると「…」のメニューが出る。右クリックでも同じ操作を選べる
private struct EntryRow: View {
    let entry: JournalEntry
    let edit: () -> Void
    let delete: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                EntryHeader(entry: entry)
                EntryBodyText(text: entry.body.unwrap())
                TagList(tags: entry.tags)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Menu {
                actions
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .opacity(hovering ? 1 : 0.35)
            .help("記入の操作")
            .accessibilityLabel("記入の操作")
            .accessibilityIdentifier("entry.menu")
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu { actions }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("entry")
    }

    @ViewBuilder
    private var actions: some View {
        Button("編集…", action: edit)
            .accessibilityIdentifier("entry.edit")
        Button("削除…", role: .destructive, action: delete)
            .accessibilityIdentifier("entry.delete")
    }
}

extension JournalEntry: @retroactive Identifiable {}

/// 記入の本文とタグを書き直すシート。⌘Return で保存し、esc でやめる
private struct EntryEditor: View {
    let entry: JournalEntry
    let known: [TagName]
    let save: (String, [TagName]) async -> Bool
    @State private var draft: String
    @State private var tags: [TagName]
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    init(entry: JournalEntry, known: [TagName], save: @escaping (String, [TagName]) async -> Bool) {
        self.entry = entry
        self.known = known
        self.save = save
        _draft = State(initialValue: entry.body.unwrap())
        _tags = State(initialValue: entry.tags)
    }

    private var canSave: Bool { !saving && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("記入を編集")
                .font(.headline)
            EntryHeader(entry: entry)
            TextEditor(text: $draft)
                .font(.body)
                .frame(minWidth: 420, minHeight: 140)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(.background, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
                .accessibilityLabel("記入の本文")
                .accessibilityIdentifier("editor.body")
            TagInput(known: known, attached: tags, onChange: { tags = $0 }, identifier: "editor.tags")
            HStack {
                Spacer()
                Button("やめる", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("保存") {
                    saving = true
                    Task {
                        if await save(draft, tags) { dismiss() }
                        saving = false
                    }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(!canSave)
                .help("保存（⌘Return）")
                .accessibilityIdentifier("editor.save")
            }
        }
        .padding(20)
    }
}
