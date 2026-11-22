import SwiftUI

/// アカウント（GLOSSARY の「記録先」）の欄。ログインしていなければこの端末の記録先で動き、ログインすると
/// アカウントの記録先に替わってほかの端末と同期する（Web の settings-screen.tsx の AccountSection）。
/// Mac は設定のアカウントのタブに、iPhone はアカウントの画面に置く
struct AccountSection<Services: RecordStoreServices>: View {
    let model: RecordStoreModel<Services>

    private var device: String { model.thisDevice.name }

    var body: some View {
        Section {
            switch model.account {
            case .signedOut:
                LabeledContent {
                    Button("ログインして同期") { Task { await model.signIn() } }
                        .accessibilityIdentifier("account.signIn")
                } label: {
                    Text("ログインしていません")
                    Text("記録は\(device) に保存されています。ログインすると、他の端末とも同期できます。")
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
            Text("\(device) の記録は、取り込むまでログインしても消えずに残ります。ログアウトすると、また使えます。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
