import NanaichiAccount
import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// 設定（⌘,、Web の settings-screen.tsx）。Mac の設定のウィンドウと同じく、まとまりごとのタブに分ける。
/// 端末ごとの設定（知らせ方・送信キー・テーマ）には「この Mac」と添え、記録先の設定（進め方・タグ）と見分ける
struct SettingsView: View {
    @Bindable var model: AppModel
    /// 記録先が替わると、そのときの画面の状態を指す
    private var app: AppServices { model.services }

    var body: some View {
        TabView(selection: $model.settingsTab) {
            Tab("タイマー", systemImage: "timer", value: .timer) {
                TimerSettings(advanceMode: app.advanceMode, tasks: app.tasks, recordStore: model.recordStoreName)
            }
                .accessibilityIdentifier("settings.tab.timer")
            Tab("知らせ方", systemImage: "bell", value: .alert) { AlertSettingsForm(app: app) }
                .accessibilityIdentifier("settings.tab.alert")
            Tab("ジャーナル", systemImage: "square.and.pencil", value: .journal) { JournalSettings() }
                .accessibilityIdentifier("settings.tab.journal")
            Tab("タグ", systemImage: "number", value: .tags) { TagSettings(tags: app.tags) }
                .accessibilityIdentifier("settings.tab.tags")
            Tab("表示", systemImage: "circle.lefthalf.filled", value: .look) { LookSettings() }
                .accessibilityIdentifier("settings.tab.look")
            Tab("アカウント", systemImage: "person.crop.circle", value: .account) { AccountSettings(model: model) }
                .accessibilityIdentifier("settings.tab.account")
        }
        .frame(width: 560)
        .frame(minHeight: 360)
    }
}

enum SettingsTab: Hashable {
    case timer, alert, journal, tags, look, account
}

private struct PerDeviceNote: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "laptopcomputer")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}

/// タイマーのタブ。フェーズの進め方と、アカウントの記録先なら ToDo の設定
private struct TimerSettings: View {
    let advanceMode: AdvanceModeModel
    /// この端末の記録先では nil。ToDo 自体を使えないので、項目も案内も出さない（ADR 0027）
    let tasks: TasksModel?
    let recordStore: String

    var body: some View {
        Form {
            AdvanceSection(model: advanceMode, recordStore: recordStore)
            if let tasks { TaskSettingSection(model: tasks) }
        }
        .formStyle(.grouped)
    }
}

/// ToDo の設定（GLOSSARY の「ToDo の設定」、ADR 0027）。アカウントの設定なので、どの端末でも同じになる
private struct TaskSettingSection: View {
    let model: TasksModel

    var body: some View {
        Section {
            switch model.setting {
            case .loading: ProgressView()
            case .loadFailed: Text("読み込めませんでした").foregroundStyle(.secondary)
            case .loaded(let setting):
                Toggle(
                    isOn: Binding(
                        get: { setting == .enabled }, set: { model.changeSetting($0 ? .enabled : .disabled) })
                ) {
                    Text("ToDo を使う")
                    Text("メインのウィンドウにタスクの一覧を出します")
                }
                .accessibilityIdentifier("settings.tasks")
            }
            if let message = model.settingErrorMessage {
                Text(message).foregroundStyle(.red)
            }
        } header: {
            Text("ToDo")
        } footer: {
            Text("オンにすると、「〜が完了した」とジャーナルに書いたとき、合うタスクを自動で完了にします。どの端末でも同じ設定になります。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// フェーズの進め方（GLOSSARY、ADR 0016）。4つの切り替わりごとに自動か手動か。変えるとセッションの途中でもすぐ効く
private struct AdvanceSection: View {
    let model: AdvanceModeModel
    /// 進め方を置いている記録先の呼び方
    let recordStore: String

    var body: some View {
        Section {
            switch model.mode {
            case .loading: ProgressView()
            case .loadFailed: Text("読み込めませんでした").foregroundStyle(.secondary)
            case .loaded(let mode):
                ForEach(PhaseTransition.allCases, id: \.self) { transition in
                    let text = transitionTextOf(transition)
                    Picker(
                        selection: Binding(
                            get: { mode[transition] }, set: { model.change(transition, to: $0) })
                    ) {
                        ForEach(advanceChoices, id: \.self) { Text(advanceChoiceTextOf($0)).tag($0) }
                    } label: {
                        Text(text.label)
                        Text(text.description)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("advance.\(transition.rawValue)")
                }
            }
            if let message = model.errorMessage {
                Text(message).foregroundStyle(.red)
            }
        } header: {
            Text("フェーズの進め方")
        } footer: {
            Text("手動にした切り替わりでは、時間が来ると 0:00 で止まって音で知らせ、進めるまで待ちます。\(recordStore)の設定です。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// 知らせ方の設定（GLOSSARY）。音で知らせるか・音量・行き先のフェーズごとの音色・通知
private struct AlertSettingsForm: View {
    let app: AppServices
    private var settings: AlertSettings { app.alertSettings.settings }

    private func change(_ next: AlertSettings) {
        app.alertSettings.change(next)
        app.timer.alertSettingsChanged()
    }

    var body: some View {
        Form {
            Section {
                Toggle(isOn: Binding(get: { settings.sound }, set: { change(with(\.sound, $0)) })) {
                    Text("音で知らせる")
                    Text("フェーズが切り替わったときに鳴らします")
                }
                .accessibilityIdentifier("alert.sound")
                Picker(
                    "音量",
                    selection: Binding(
                        get: { settings.volume },
                        set: { volume in
                            change(with(\.volume, volume))
                            // 選んだ音量をすぐ聞けるようにする
                            app.alert.preview(to: .journal, settings: app.alertSettings.settings)
                        })
                ) {
                    ForEach(Volume.allCases, id: \.self) { Text(volumeTextOf($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .disabled(!settings.sound)
                .accessibilityIdentifier("alert.volume")
            } footer: {
                PerDeviceNote(text: "この Mac の設定です")
            }
            Section("音色") {
                ForEach(toneTargets, id: \.self) { to in
                    ToneRow(to: to, settings: settings, enabled: settings.sound) { tone in
                        change(settings.withTone(tone, to: to))
                        app.alert.preview(to: to, settings: app.alertSettings.settings)
                    } preview: {
                        app.alert.preview(to: to, settings: settings)
                    }
                }
            }
            Section {
                Toggle(
                    isOn: Binding(
                        get: { settings.notification },
                        set: { on in
                            change(with(\.notification, on))
                            if on { app.timer.requestNotificationAuthorization() }
                        })
                ) {
                    Text("通知")
                    Text("切り替わりを通知センターにも出します。許可はシステム設定の「通知」で変えられます")
                }
                .accessibilityIdentifier("alert.notification")
            }
        }
        .formStyle(.grouped)
    }

    private func with<Value>(_ keyPath: WritableKeyPath<AlertSettings, Value>, _ value: Value) -> AlertSettings {
        var next = settings
        next[keyPath: keyPath] = value
        return next
    }
}

private struct ToneRow: View {
    let to: PhaseKind
    let settings: AlertSettings
    let enabled: Bool
    let choose: (AlertTone) -> Void
    let preview: () -> Void

    var body: some View {
        let text = toneTargetOf(to)
        LabeledContent {
            HStack {
                Picker(text.label, selection: Binding(get: { settings.tones[to] }, set: { choose($0) })) {
                    ForEach(AlertTone.allCases, id: \.self) { Text(toneTextOf($0)).tag($0) }
                }
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("tone.\(to.rawValue)")
                Button("試す", systemImage: "play.fill", action: preview)
                    .help("\(text.label)の音を試す")
                    .accessibilityLabel("\(text.label)の音を試す")
                    .accessibilityIdentifier("tone.\(to.rawValue).preview")
            }
            .disabled(!enabled)
        } label: {
            Text(text.label)
            Text(text.description)
        }
    }
}

private struct JournalSettings: View {
    @AppStorage(PreferenceKey.submitKey) private var submitKey = SubmitKey.defaultKey

    var body: some View {
        Form {
            Section {
                Picker(selection: $submitKey) {
                    ForEach(SubmitKey.allCases, id: \.self) { Text($0.label).tag($0) }
                } label: {
                    Text("送信キー")
                    Text("入力欄の隣でも切り替えられます")
                }
                .accessibilityIdentifier("settings.submitKey")
            } footer: {
                PerDeviceNote(text: "この Mac の設定です")
            }
        }
        .formStyle(.grouped)
    }
}

private struct LookSettings: View {
    @AppStorage(PreferenceKey.theme) private var theme = ThemePreference.system

    var body: some View {
        Form {
            Section {
                Picker("テーマ", selection: $theme) {
                    ForEach(ThemePreference.allCases, id: \.self) { Text(themeTextOf($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("settings.theme")
            } footer: {
                PerDeviceNote(text: "この Mac の設定です")
            }
        }
        .formStyle(.grouped)
        .onChange(of: theme) { _, preference in applyTheme(preference) }
    }
}

// MARK: - アカウント

/// アカウント（GLOSSARY の「記録先」）。ログインしていなければこの Mac の記録先で動き、ログインすると
/// アカウントの記録先に替わってほかの端末と同期する（Web の settings-screen.tsx の AccountSection）
private struct AccountSettings: View {
    let model: AppModel

    var body: some View {
        Form {
            Section {
                switch model.account {
                case .signedOut:
                    LabeledContent {
                        Button("ログインして同期") { Task { await model.signIn() } }
                            .accessibilityIdentifier("account.signIn")
                    } label: {
                        Text("ログインしていません")
                        Text("記録はこの Mac に保存されています。ログインすると、他の端末とも同期できます。")
                    }
                case .signingIn:
                    LabeledContent {
                        ProgressView().controlSize(.small)
                    } label: {
                        Text("ログインしています")
                        Text("ブラウザの画面で Google のアカウントを選んでください。")
                    }
                case .signedIn(let user):
                    LabeledContent {
                        Button("ログアウト") { Task { await model.signOut() } }
                            .accessibilityIdentifier("account.signOut")
                    } label: {
                        switch user {
                        case .loading, .loadFailed: Text("ログインしています")
                        case .loaded(let user):
                            Text(user.name)
                            Text(user.email.unwrap())
                                .accessibilityIdentifier("account.email")
                        }
                        Text("記録はアカウントに保存され、他の端末と同期します。")
                    }
                case .signingOut:
                    LabeledContent {
                        ProgressView().controlSize(.small)
                    } label: {
                        Text("ログアウトしています")
                    }
                }
                if let message = model.accountMessage {
                    Text(message)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("account.message")
                }
            } header: {
                Text("アカウント")
            } footer: {
                Text("この Mac の記録は、ログインしても消えずに残ります。ログアウトすると、また使えます。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - タグ

/// タグ（GLOSSARY の「タグの削除」、ADR 0017）。使っているタグとついている記入の数を出し、使わないタグを削除できる
private struct TagSettings: View {
    let tags: TagsModel
    @State private var deleting: TagUsage?

    var body: some View {
        Form {
            Section {
                switch tags.usage {
                case .loading: ProgressView()
                case .loadFailed: Text("読み込めませんでした").foregroundStyle(.secondary)
                case .loaded(let usage):
                    if usage.isEmpty {
                        Text("まだタグを使っていません").foregroundStyle(.secondary)
                    }
                    ForEach(usage, id: \.name) { item in
                        LabeledContent {
                            Button("削除…") { deleting = item }
                                .accessibilityLabel("\(tagTextOf(item.name))を削除")
                                .accessibilityIdentifier("tag.delete.\(item.name.rawValue)")
                        } label: {
                            Text(tagTextOf(item.name))
                            Text(taggedEntryCountTextOf(item.entryCount))
                        }
                    }
                }
            } header: {
                Text("タグ")
            } footer: {
                Text(
                    "\(tags.usage.value.map { tagKindsNoteOf(inUse: $0.count) } ?? "")削除しても記入は消えず、タグだけを外すか、別のタグに付け替えます。"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .sheet(item: $deleting) { usage in
            TagDeletionSheet(
                usage: usage,
                others: (tags.usage.value ?? []).map(\.name).filter { $0 != usage.name },
                delete: { await tags.delete(usage.name, deletion: $0) })
        }
    }
}

extension TagUsage: @retroactive Identifiable {
    public var id: TagName { name }
}

/// 1つのタグを削除する前に、ついている記入のタグを外すか付け替えるかを選ぶ（GLOSSARY の「タグの削除」）。
/// 付け替え先は使っている他のタグ `others` から選ぶ
struct TagDeletionSheet: View {
    let usage: TagUsage
    let others: [TagName]
    let delete: (TagDeletion) async -> String?
    @State private var reassign = false
    @State private var target: TagName?
    @State private var pending = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    private var deletion: TagDeletion {
        if reassign, let to = target ?? others.first { return .reassign(to: to) }
        return .detach
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(tagTextOf(usage.name)) を削除")
                .font(.headline)
            Text(tagDeletionMessageOf(usage, deletion))
                .fixedSize(horizontal: false, vertical: true)
            if !others.isEmpty {
                Picker("ついている記入のタグ", selection: $reassign) {
                    Text("外すだけ").tag(false)
                    Text("別のタグに付け替える").tag(true)
                }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("tagDeletion.choice")
                if reassign {
                    Picker("付け替え先のタグ", selection: Binding(get: { target ?? others[0] }, set: { target = $0 })) {
                        ForEach(others, id: \.self) { Text(tagTextOf($0)).tag($0) }
                    }
                    .fixedSize()
                    .accessibilityIdentifier("tagDeletion.target")
                }
            }
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("やめる", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(tagDeletionActionOf(deletion), role: .destructive) {
                    pending = true
                    Task {
                        errorMessage = await delete(deletion)
                        pending = false
                        if errorMessage == nil { dismiss() }
                    }
                }
                .disabled(pending)
                .accessibilityIdentifier("tagDeletion.confirm")
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
