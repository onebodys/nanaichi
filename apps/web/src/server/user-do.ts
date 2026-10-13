import { DurableObject } from "cloudflare:workers";

// Durable Object はランタイムの都合でクラス継承が必須（kamae の「クラスを使わない」からの例外）。
// ユーザーごとのセッション・ジャーナル記入を持つ。中身は M3（#4）で実装する。
export class UserDO extends DurableObject<Env> {}
