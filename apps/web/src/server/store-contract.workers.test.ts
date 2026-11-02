import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { storeContract } from "../testing/store-contract.ts";
import { journalSqlite } from "./journal-sqlite.ts";
import { sessionSqlite } from "./session-sqlite.ts";
import { statsSqlite } from "./stats-sqlite.ts";

storeContract((scene) =>
  runInDurableObject(env.USER_DO.getByName(crypto.randomUUID()), (_, state) => {
    const { sql } = state.storage;
    scene({ ...sessionSqlite(sql), ...journalSqlite(sql), ...statsSqlite(sql) });
  }),
);
