import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { storeContract } from "../testing/store-contract.ts";
import { journalSqlite } from "./journal-sqlite.ts";
import { sessionSqlite } from "./session-sqlite.ts";
import { statsSqlite } from "./stats-sqlite.ts";

// UserDO が渡すのと同じ、SQLite のアダプタを広げた読み書きの契約で場面を動かす。
// 場面ごとに新しい UserDO を使うので、記録は混ざらない
storeContract((scene) =>
  runInDurableObject(env.USER_DO.getByName(crypto.randomUUID()), (_, state) => {
    const { sql } = state.storage;
    scene({ ...sessionSqlite(sql), ...journalSqlite(sql), ...statsSqlite(sql) });
  }),
);
