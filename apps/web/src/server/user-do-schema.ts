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
