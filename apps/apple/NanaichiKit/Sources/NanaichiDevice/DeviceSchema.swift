import GRDB

/// この端末の記録先の SQLite のスキーマ（ADR 0028）。
///
/// 表と列は UserDO の SQLite（`apps/web/src/server/user-do-schema.ts`）を当て終えた形と同じにする。
/// ログインしたときの取り込み（Issue #146）で、行をそのまま写せるようにするため。
/// タスク（ADR 0026・0027）はアカウントだけのものなので、その表は作らない。
/// 時刻はすべて UNIX エポックからのミリ秒（INTEGER）で持つ。
/// **一度リリースしたマイグレーションは書き換えず、変更は末尾に足す。**
enum DeviceSchema {
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(
                sql: """
                    CREATE TABLE sessions (
                      id TEXT PRIMARY KEY,
                      started_at INTEGER NOT NULL,
                      -- 閉じていなければどちらも NULL。自動終了なら最後の記入・操作の時刻で閉じる
                      ended_at INTEGER,
                      ended_by TEXT CHECK (ended_by IN ('End', 'AutoEnd')),
                      CHECK ((ended_at IS NULL) = (ended_by IS NULL))
                    );

                    -- 同時に持てるセッションは1つまで。閉じていないセッションの行はこの式が全部 1 になるので、
                    -- 2行目を入れようとすると一意制約で失敗する
                    CREATE UNIQUE INDEX sessions_one_open ON sessions ((ended_at IS NULL)) WHERE ended_at IS NULL;

                    -- タイムラインはセッションを開始時刻の新しい順にページを送る（ADR 0011）
                    CREATE INDEX sessions_by_started_at ON sessions (started_at);

                    -- 操作イベント。id は端末が発行した ID（ADR 0007）。同じミリ秒の操作は rowid の順に並べる
                    CREATE TABLE session_events (
                      id TEXT PRIMARY KEY,
                      session_id TEXT NOT NULL REFERENCES sessions (id),
                      kind TEXT NOT NULL CHECK (
                        kind IN ('Start', 'Pause', 'Resume', 'Abort', 'RestartFocus', 'SkipBreak', 'Advance', 'End')
                      ),
                      at INTEGER NOT NULL
                    );
                    CREATE INDEX session_events_by_session ON session_events (session_id, at);

                    CREATE TABLE journal_entries (
                      id TEXT PRIMARY KEY,
                      session_id TEXT NOT NULL REFERENCES sessions (id),
                      body TEXT NOT NULL,
                      written_at INTEGER NOT NULL,
                      round INTEGER NOT NULL,
                      -- 休憩中に書いたものはどのセットにも紐付かない
                      set_number INTEGER,
                      -- 待機中に書いたものはどのフェーズにも紐付かない
                      phase TEXT CHECK (phase IN ('Focus', 'Journal', 'Break')),
                      updated_at INTEGER NOT NULL,
                      -- 削除は論理削除
                      deleted_at INTEGER
                    );
                    CREATE INDEX journal_entries_by_session ON journal_entries (session_id, written_at);
                    CREATE INDEX journal_entries_by_written_at ON journal_entries (written_at);

                    -- 記入についたタグ（ADR 0013）。名前は正規化してから記録する。
                    -- 記入を論理削除しても行は残し、読むときに除く
                    CREATE TABLE journal_entry_tags (
                      entry_id TEXT NOT NULL REFERENCES journal_entries (id),
                      -- つけた順
                      position INTEGER NOT NULL,
                      name TEXT NOT NULL,
                      PRIMARY KEY (entry_id, position),
                      UNIQUE (entry_id, name)
                    );
                    CREATE INDEX journal_entry_tags_by_name ON journal_entry_tags (name);

                    -- フェーズの進め方の変更履歴（ADR 0016）。いまの進め方は最後の行で、行がなければすべて自動。
                    -- 過去のセッションの計算に要るので消さない
                    CREATE TABLE advance_mode_changes (
                      changed_at INTEGER NOT NULL,
                      focus_to_journal TEXT NOT NULL CHECK (focus_to_journal IN ('Auto', 'Manual')),
                      journal_to_focus TEXT NOT NULL CHECK (journal_to_focus IN ('Auto', 'Manual')),
                      journal_to_break TEXT NOT NULL CHECK (journal_to_break IN ('Auto', 'Manual')),
                      break_to_focus TEXT NOT NULL CHECK (break_to_focus IN ('Auto', 'Manual'))
                    );
                    CREATE INDEX advance_mode_changes_by_time ON advance_mode_changes (changed_at);
                    """)
        }
        return migrator
    }
}
