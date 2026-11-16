// データベースのバックアップ（1時間ごと。Cloud Run ジョブ zerobit-backup を Cloud Scheduler が動かす。仕様書8章）
//
//   node scripts/backup.mjs
//
// してること：
//   1. バックアップ専用のロール zb_backup（全部を読むだけ）で接続し、core.integration_runs に「始めた」を書く
//   2. ある一瞬の状態（スナップショット）を決め、その状態のまま、表ごとの行数を数えて pg_dump する
//   3. pg_dump の出力を age の公開鍵で暗号化する（復号の鍵はクラウドに置かない。紙とパスワード管理ツールだけ）
//   4. 大阪のバケットに置く：db/hourly/年/月/日/時分秒.dump.age と、行数などの控え（同じ名前の .json）
//      その日・その月・その年で最初のものは db/daily・db/monthly・db/yearly にも写す（消す期間はバケットの設定で決まる）
//   5. 記録を「成功」にする（大きさ・ハッシュ・置いた場所・表の数・行数の合計だけ。中身は残さない）
// 置いたものは書き換えない・消さない（同じ名前があれば失敗。ジョブのアカウントには消す権限がない）。
//
// 環境変数：
//   DATABASE_URL_BACKUP … zb_backup の接続先（Secret Manager の db-backup-url）
//   ZB_BACKUP_RECIPIENT … age の公開鍵（age1…。Secret Manager の backup-age-recipient）
//   ZB_BACKUP_BUCKET    … 置き場所のバケット（大阪）。開発中は代わりに ZB_BACKUP_DIR（このPCのフォルダ）
//   ZB_ENV              … stg / prod（控えに書くだけ）
// 必要なもの：pg_dump（PostgreSQL 16 用）と age。本番・検証では Dockerfile の backup のイメージに入っている
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const SCHEMAS = ['core', 'pii', 'audit', 'auth', 'public'];

/**
 * 置き場所。どれも、もうある名前には書かない
 * @typedef {{
 *   describe(name: string): string,
 *   exists(name: string): Promise<boolean>,
 *   putFile(name: string, path: string): Promise<void>,
 *   putText(name: string, text: string): Promise<void>,
 *   copy(from: string, to: string): Promise<void>,
 * }} BackupTarget
 */
/**
 * 1回の結果
 * @typedef {{ ok: true, runId: number, bytes: number, sha256: string, object: string, tables: number, rows: number, copies: string[], error?: undefined }
 *   | { ok: false, runId?: number, error: string, bytes?: undefined, sha256?: undefined, object?: undefined, copies?: undefined }} BackupResult
 */
const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

/** 日本時間の年月日・時分秒（2けたにそろえる） */
export function jstParts(date) {
  const t = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return {
    y: p(t.getUTCFullYear(), 4),
    m: p(t.getUTCMonth() + 1),
    d: p(t.getUTCDate()),
    hh: p(t.getUTCHours()),
    mm: p(t.getUTCMinutes()),
    ss: p(t.getUTCSeconds()),
  };
}

/** 置く場所の名前。hourly は毎回、daily・monthly・yearly はその期間で最初の1つだけ */
export function objectNames(date) {
  const { y, m, d, hh, mm, ss } = jstParts(date);
  return {
    hourly: `db/hourly/${y}/${m}/${d}/${hh}${mm}${ss}.dump.age`,
    daily: `db/daily/${y}/${m}/${d}.dump.age`,
    monthly: `db/monthly/${y}/${m}.dump.age`,
    yearly: `db/yearly/${y}.dump.age`,
  };
}

/** バックアップの名前 → 控え（行数など）の名前 */
export function manifestName(objectName) {
  return objectName.replace(/\.dump\.age$/, '.json');
}

/** 記録に残すエラーの文（300字まで。接続文字列のパスワードは伏せる） */
export function shortError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+):[^@\s]+@/gi, '$1:***@').replace(/\s+/g, ' ').trim().slice(0, 300) || '不明なエラー';
}

/** 接続文字列からパスワードを外す（pg_dump の引数に出さず、PGPASSWORD で渡すため） */
export function splitPassword(url) {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), password };
}

// ---------- 置き場所（Cloud Storage／このPCのフォルダ）。どちらも、ある名前には書かない ----------

/**
 * Cloud Storage のバケット
 * @param {string} bucketName
 * @returns {Promise<BackupTarget>}
 */
export async function gcsTarget(bucketName) {
  const { Storage } = await import('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  const once = { preconditionOpts: { ifGenerationMatch: 0 } };
  return {
    describe: (name) => `gs://${bucketName}/${name}`,
    async exists(name) {
      const [ok] = await bucket.file(name).exists();
      return ok;
    },
    async putFile(name, path) {
      await bucket.upload(path, { destination: name, resumable: true, contentType: 'application/octet-stream', ...once });
    },
    async putText(name, text) {
      await bucket.file(name).save(text, { resumable: false, contentType: 'application/json', ...once });
    },
    async copy(from, to) {
      await bucket.file(from).copy(bucket.file(to), once);
    },
  };
}

/**
 * このPCのフォルダ（開発・テスト用）
 * @param {string} dir
 * @returns {BackupTarget}
 */
export function localTarget(dir) {
  const full = (name) => join(dir, ...name.split('/'));
  const put = async (name, write) => {
    await mkdir(dirname(full(name)), { recursive: true });
    await write(full(name));
  };
  return {
    describe: (name) => full(name),
    async exists(name) {
      return stat(full(name)).then(() => true, () => false);
    },
    putFile: (name, path) => put(name, (to) => copyFile(path, to, 1 /* COPYFILE_EXCL */)),
    putText: (name, text) => put(name, (to) => writeFile(to, text, { flag: 'wx' })),
    copy: (from, to) => put(to, (dest) => copyFile(full(from), dest, 1)),
  };
}

// ---------- pg_dump → age ----------

function exited(child, name, stderr) {
  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`${name} を動かせません：${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} が失敗しました（${code}）：${stderr().slice(-200)}`))));
  });
}

/**
 * pg_dump（カスタム形式）を age で暗号化して file に書く。決めたスナップショットの状態をそのまま書き出す
 * @returns {Promise<{ bytes: number, sha256: string }>}
 */
export async function dumpEncrypted({ url, snapshot, recipient, file }) {
  const { url: dbname, password } = splitPassword(url);
  const env = { ...process.env, PGPASSWORD: password };
  const dump = spawn('pg_dump', ['--format=custom', '--compress=6', `--snapshot=${snapshot}`, '--no-password', `--dbname=${dbname}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const age = spawn('age', ['--encrypt', '--recipient', recipient], { stdio: ['pipe', 'pipe', 'pipe'] });
  let dumpErr = '';
  let ageErr = '';
  dump.stderr.on('data', (c) => (dumpErr += c));
  age.stderr.on('data', (c) => (ageErr += c));
  const hash = createHash('sha256');
  let bytes = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await Promise.all([
    pipeline(dump.stdout, age.stdin),
    pipeline(age.stdout, count, createWriteStream(file, { flags: 'wx' })),
    exited(dump, 'pg_dump', () => dumpErr),
    exited(age, 'age', () => ageErr),
  ]);
  return { bytes, sha256: hash.digest('hex') };
}

function pgDumpVersion() {
  const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------- 本体 ----------

async function inTx(client, fn) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL app.actor_kind = 'system'"); // 監査ログのため（ルール7）
    const r = await fn();
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * バックアップを1回とる
 * @param {object} o
 * @param {string} o.url         zb_backup の接続先
 * @param {string} o.recipient   age の公開鍵
 * @param {BackupTarget} o.target  置き場所
 * @param {Date}   [o.now]
 * @param {string} [o.env]       stg / prod
 * @param {'scheduled'|'manual'} [o.mode]
 * @param {typeof dumpEncrypted} [o.dump]  テストでは差し替える
 * @param {(message: string) => void} [o.log]
 * @returns {Promise<BackupResult>}
 */
export async function runBackup({ url, recipient, target, now = new Date(), env = 'dev', mode = 'scheduled', dump = dumpEncrypted, log = console.log }) {
  if (!url) throw new Error('DATABASE_URL_BACKUP（バックアップ用の接続先）がありません');
  if (!RECIPIENT.test(recipient ?? '')) throw new Error('ZB_BACKUP_RECIPIENT（age の公開鍵 age1…）がありません、または形が正しくありません');

  const rec = new pg.Client({ connectionString: url });
  await rec.connect();
  /** @type {number | undefined} */
  let runId;
  /** @type {BackupResult} */
  let work;
  try {
    runId = await inTx(rec, async () => {
      const r = await rec.query(`INSERT INTO core.integration_runs (kind, mode) VALUES ('db_backup', $1) RETURNING id`, [mode]);
      return r.rows[0].id;
    });
    const names = objectNames(now);
    const tmp = await mkdtemp(join(tmpdir(), 'zb-backup-'));
    try {
      // ある一瞬の状態を決め、その状態で数えて、その状態を書き出す
      const snap = new pg.Client({ connectionString: url });
      await snap.connect();
      let counts;
      let result;
      const file = join(tmp, 'db.dump.age');
      try {
        await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { rows: [{ id: snapshot }] } = await snap.query('SELECT pg_export_snapshot() AS id');
        const { rows: tables } = await snap.query(
          `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p') ORDER BY 1, 2`,
          [SCHEMAS],
        );
        counts = {};
        for (const t of tables) {
          const ident = `${snap.escapeIdentifier(t.schema)}.${snap.escapeIdentifier(t.name)}`;
          const { rows: [{ n }] } = await snap.query(`SELECT count(*)::bigint AS n FROM ${ident}`);
          counts[`${t.schema}.${t.name}`] = Number(n);
        }
        result = await dump({ url, snapshot, recipient, file });
        await snap.query('COMMIT');
      } finally {
        await snap.end().catch(() => {});
      }

      const manifest = {
        format: 'zerobit-db-backup/1',
        env,
        created_at: now.toISOString(),
        object: names.hourly,
        bytes: result.bytes,
        sha256: result.sha256,
        encryption: 'age',
        recipient,
        pg_dump: pgDumpVersion(),
        restore: 'age --decrypt -i 鍵のファイル < この.dump.age > db.dump  →  pg_restore --list db.dump（docs/deploy.md「バックアップから戻す」）',
        tables: counts,
      };
      await target.putFile(names.hourly, file);
      await target.putText(manifestName(names.hourly), JSON.stringify(manifest, null, 2) + '\n');
      const copies = [];
      for (const period of ['daily', 'monthly', 'yearly']) {
        if (await target.exists(names[period])) continue;
        await target.copy(names.hourly, names[period]);
        await target.copy(manifestName(names.hourly), manifestName(names[period]));
        copies.push(period);
      }
      const rows = Object.values(counts).reduce((a, b) => a + b, 0);
      const summary = { bytes: result.bytes, sha256: result.sha256, object: names.hourly, tables: Object.keys(counts).length, rows, copies };
      await inTx(rec, () =>
        rec.query(`UPDATE core.integration_runs SET finished_at = now(), ok = true, summary = $2 WHERE id = $1`, [runId, summary]),
      );
      log(`✓ バックアップ：${target.describe(names.hourly)}（${result.bytes} バイト、表 ${summary.tables}・行 ${rows}${copies.length ? `。${copies.join('・')} にも写した` : ''}）`);
      work = { ok: true, runId, ...summary };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } catch (error) {
    const message = shortError(error);
    if (runId) {
      await inTx(rec, () =>
        rec.query(`UPDATE core.integration_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1`, [runId, message]),
      ).catch(() => {});
    }
    work = { ok: false, runId, error: message };
  } finally {
    await rec.end().catch(() => {});
  }
  return work;
}

/** ファイルの sha256（控えの値と合うかを確かめる。復元の試験用） */
export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const bucket = process.env.ZB_BACKUP_BUCKET?.trim();
  const dir = process.env.ZB_BACKUP_DIR?.trim();
  try {
    if (!bucket && !dir) throw new Error('置き場所（ZB_BACKUP_BUCKET または ZB_BACKUP_DIR）がありません');
    const target = bucket ? await gcsTarget(bucket) : localTarget(dir);
    const r = await runBackup({
      url: process.env.DATABASE_URL_BACKUP,
      recipient: process.env.ZB_BACKUP_RECIPIENT?.trim(),
      target,
      env: process.env.ZB_ENV || 'dev',
      mode: process.env.ZB_BACKUP_MODE === 'manual' ? 'manual' : 'scheduled',
    });
    if (!r.ok) {
      console.error(`✗ バックアップに失敗しました：${r.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`✗ バックアップに失敗しました：${shortError(error)}`);
    process.exit(1);
  }
}
