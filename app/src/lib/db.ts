import "server-only";
import { Pool, types, type PoolClient } from "pg";

// PostgreSQL の型をそのまま扱いやすい形で受け取る
types.setTypeParser(1082, (v) => v); // date → 'YYYY-MM-DD'（時差でずれないよう文字列のまま）
types.setTypeParser(20, (v) => Number(v)); // bigint → number（金額・IDは安全な範囲に収まる）
types.setTypeParser(1700, (v) => Number(v)); // numeric → number（温度など）

// アプリは個人情報を読めない DB ロール zb_app で接続する（CLAUDE.md ルール2）。
// 接続先は app/.env.local の DATABASE_URL（npm run db:reset / db:seed が書き込む）
const globalForDb = globalThis as unknown as { zbPool?: Pool };

function createPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL がありません。リポジトリの一番上で npm run db:seed を実行してください。",
    );
  }
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}

export function getPool(): Pool {
  if (!globalForDb.zbPool) globalForDb.zbPool = createPool();
  return globalForDb.zbPool;
}

/** 読み取り用の問い合わせ。値は必ず $1, $2 … で渡す（SQLに文字を埋め込まない） */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export type Actor =
  | { kind: "user"; userId: number }
  | { kind: "system" }
  | { kind: "ai" };

/**
 * 書き込みはこの中で行う。トランザクションの先頭で実行者を設定するので、
 * 監査ログに「誰が」が残る（CLAUDE.md ルール7）。エラーなら全部取り消す。
 */
export async function withActor<T>(actor: Actor, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', $1, true)", [actor.kind]);
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [
      actor.kind === "user" ? String(actor.userId) : "",
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
