/**
 * UserDO の SQLite のスキーマ（ADR 0002）。
 *
 * DO の SQLite は D1 と違って `wrangler d1 migrations` が使えないので、DO が起動するたびに
 * まだ当てていないものを順に当てる。当てたものは `schema_migrations` に記録する
 * （DO の SQLite では `PRAGMA user_version` が許可されていない）。
 * **一度リリースしたものは書き換えず、変更は末尾に足す。**
 *
 * 時刻はすべて UNIX エポックからのミリ秒（INTEGER）で持つ。
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `
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

  CREATE TABLE session_events (
    -- クライアントが発行した ID（ADR 0007）。同じ ID の操作を二重に記録しない
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    kind TEXT NOT NULL CHECK (
      kind IN ('Start', 'Pause', 'Resume', 'Abort', 'RestartFocus', 'SkipBreak', 'End')
    ),
    at INTEGER NOT NULL
  );

  CREATE INDEX session_events_by_session ON session_events (session_id, at);

  -- 記入・編集・削除の API と画面は #6 で作る。ここでは自動終了の判断に記入の時刻を使う
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
  `,
  `
  -- タイムラインはセッションを開始時刻の新しい順にページを送る（ADR 0011）
  CREATE INDEX sessions_by_started_at ON sessions (started_at);
  `,
  `
  -- 記入についたタグ（ADR 0013）。タグの表は作らず、記入についた名前として持つ。
  -- 名前は正規化してから記録する。記入を論理削除しても行は残し、読むときに除く
  CREATE TABLE journal_entry_tags (
    entry_id TEXT NOT NULL REFERENCES journal_entries (id),
    -- つけた順
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (entry_id, position),
    UNIQUE (entry_id, name)
  );

  -- 候補・上限の判断と、今後の集計（タグで記入を探す）のため
  CREATE INDEX journal_entry_tags_by_name ON journal_entry_tags (name);
  `,
  `
  -- 操作イベントに「進める」を足す（ADR 0015）。SQLite は CHECK 制約を変えられないので作り直す。
  -- 同じミリ秒の操作は rowid の順に並べるので、rowid も写す
  CREATE TABLE session_events_next (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    kind TEXT NOT NULL CHECK (
      kind IN ('Start', 'Pause', 'Resume', 'Abort', 'RestartFocus', 'SkipBreak', 'Advance', 'End')
    ),
    at INTEGER NOT NULL
  );
  INSERT INTO session_events_next (rowid, id, session_id, kind, at)
    SELECT rowid, id, session_id, kind, at FROM session_events;
  DROP TABLE session_events;
  ALTER TABLE session_events_next RENAME TO session_events;
  CREATE INDEX session_events_by_session ON session_events (session_id, at);

  -- フェーズの進め方の変更履歴（ADR 0015）。いまの進め方は最後の行で、行がなければすべて自動。
  -- 過去のセッションの計算に要るので消さない
  CREATE TABLE advance_mode_changes (
    changed_at INTEGER NOT NULL,
    focus_to_journal TEXT NOT NULL CHECK (focus_to_journal IN ('Auto', 'Manual')),
    journal_to_focus TEXT NOT NULL CHECK (journal_to_focus IN ('Auto', 'Manual')),
    journal_to_break TEXT NOT NULL CHECK (journal_to_break IN ('Auto', 'Manual')),
    break_to_focus TEXT NOT NULL CHECK (break_to_focus IN ('Auto', 'Manual'))
  );
  CREATE INDEX advance_mode_changes_by_time ON advance_mode_changes (changed_at);
  `,
];

/** まだ当てていないマイグレーションを順に当てる。DO の SQLite は同期 API なので、そのまま実行してよい */
export const migrate = (sql: SqlStorage, appliedAt: Date): void => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = sql
    .exec<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")
    .one().version;

  MIGRATIONS.forEach((migration, index) => {
    const version = index + 1;
    if (version <= applied) {
      return;
    }
    sql.exec(migration);
    sql.exec(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      version,
      appliedAt.getTime(),
    );
  });
};
