// 本番・検証環境のデータベースに、まだ流していないマイグレーションだけを流す（足すだけ。作り直さない）。
//   node app/scripts/migrate.mjs            （接続先は DATABASE_URL_ADMIN。管理者＝postgres で接続する）
//   ZB_APP_PASSWORD があれば、アプリ用のロール zb_app のパスワードもそれにする
// 流したファイルは public.schema_migrations に名前と中身のハッシュ（sha256）を残す。
// すでに流したファイルの中身が変わっていたら、何もせずに止める（既存のマイグレーションは書き換えない：ルール8）。
// 1つのファイルは1つのトランザクションで流し、記録も同じトランザクションで書く（途中で落ちても半端にならない）。
// 同時に2つ動かないよう、アドバイザリロックをかける。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.env.MIGRATIONS_DIR || [join(here, '..', '..', 'db', 'migrations'), join(here, '..', 'db', 'migrations')].find(existsSync);
const LOCK_KEY = 4207190001; // このシステムのマイグレーション用

export const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** ファイルの外側の BEGIN; と COMMIT; を外す（こちらでトランザクションを張るため） */
export function unwrap(sql, name) {
  const m = sql.match(/^((?:\s*--[^\n]*\n|\s+)*)BEGIN;([\s\S]*)COMMIT;\s*$/);
  if (!m) throw new Error(`${name} は BEGIN; で始まり COMMIT; で終わる形になっていません`);
  return m[2];
}

export function listMigrations(directory = dir) {
  return readdirSync(directory)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const text = readFileSync(join(directory, f), 'utf8');
      return { name: f, text, sha256: createHash('sha256').update(text).digest('hex') };
    });
}

export async function migrate({ url = process.env.DATABASE_URL_ADMIN, appPassword = process.env.ZB_APP_PASSWORD, log = console.log } = {}) {
  if (!url) throw new Error('DATABASE_URL_ADMIN（管理者で接続する先）がありません');
  if (!dir) throw new Error('db/migrations が見つかりません');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(MIGRATIONS_TABLE_SQL);
    const done = new Map((await client.query('SELECT filename, sha256 FROM public.schema_migrations')).rows.map((r) => [r.filename, r.sha256]));
    const files = listMigrations();
    // 先に全部確かめる（書き換えられたファイルがあれば、1つも流さない）
    for (const f of files) {
      if (done.has(f.name) && done.get(f.name) !== f.sha256) {
        throw new Error(`${f.name} は流したあとに中身が変わっています。既存のマイグレーションは書き換えず、新しいファイルを足してください（ルール8）`);
      }
    }
    for (const name of done.keys()) {
      if (!files.some((f) => f.name === name)) throw new Error(`流したはずの ${name} がありません`);
    }
    let applied = 0;
    for (const f of files) {
      if (done.has(f.name)) continue;
      log(`→ ${f.name}`);
      await client.query('BEGIN');
      try {
        await client.query(unwrap(f.text, f.name));
        await client.query('INSERT INTO public.schema_migrations (filename, sha256) VALUES ($1, $2)', [f.name, f.sha256]);
        await client.query('COMMIT');
        applied++;
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${f.name} でエラーになりました：${error instanceof Error ? error.message : error}`);
      }
    }
    if (appPassword) {
      await client.query(`ALTER ROLE zb_app WITH LOGIN PASSWORD ${client.escapeLiteral(appPassword)}`);
    }
    log(`✓ マイグレーション：${applied}件を流しました（全部で ${files.length}件）`);
    return { applied, total: files.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().catch((error) => {
    // 接続文字列（パスワード入り）は出さない
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
