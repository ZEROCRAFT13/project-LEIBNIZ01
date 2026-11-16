// データベースのバックアップ（app/scripts/backup.mjs）と、ホームの警告の計算
//   DB を使うテストは、npm test が渡す DATABASE_URL_BACKUP（テスト用DBの zb_backup）で動かす
//   pg_dump と age があれば、本当に暗号化して、鍵で戻して中身の一覧を出せるところまで確かめる
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dumpEncrypted,
  jstParts,
  localTarget,
  manifestName,
  objectNames,
  runBackup,
  sha256File,
  shortError,
  splitPassword,
} from "../../scripts/backup.mjs";
import { backupWarnings, JUMP_MIN_BYTES, median, megabytes, restoreTestDue } from "@/lib/backup-calc";
import { getBackupWarnings, getRestoreTestStatus } from "@/lib/backup-health";
import { getPool, query } from "@/lib/db";

const BACKUP_URL = process.env.DATABASE_URL_BACKUP;
// 形だけ正しい公開鍵（まねた pg_dump では使わない）
const FAKE_RECIPIENT = `age1${"q".repeat(58)}`;
const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;
const HAS_TOOLS = has("pg_dump") && has("age") && has("pg_restore");

describe("名前と文の形", () => {
  it("日本時間で、時分秒まで入れた名前にする（日付の変わり目）", () => {
    const at = new Date("2026-11-30T15:07:09Z"); // 日本時間 12/1 0:07:09
    expect(jstParts(at)).toEqual({ y: "2026", m: "12", d: "01", hh: "00", mm: "07", ss: "09" });
    expect(objectNames(at)).toEqual({
      hourly: "db/hourly/2026/12/01/000709.dump.age",
      daily: "db/daily/2026/12/01.dump.age",
      monthly: "db/monthly/2026/12.dump.age",
      yearly: "db/yearly/2026.dump.age",
    });
    expect(manifestName("db/daily/2026/12/01.dump.age")).toBe("db/daily/2026/12/01.json");
  });

  it("エラーの文に接続文字列のパスワードを残さない・300字まで", () => {
    const e = new Error('connect failed: postgres://zb_backup:s3cr%2Fet@localhost/zerobit?host=/cloudsql/x "x"');
    expect(shortError(e)).not.toContain("s3cr");
    expect(shortError(e)).toContain("postgres://zb_backup:***@localhost");
    expect(shortError("あ".repeat(400))).toHaveLength(300);
  });

  it("pg_dump には接続文字列からパスワードを外して渡す", () => {
    const r = splitPassword("postgres://zb_backup:p%40ss@localhost/zerobit?host=/cloudsql/p:asia-northeast1:zerobit-db");
    expect(r.password).toBe("p@ss");
    expect(r.url).toBe("postgres://zb_backup@localhost/zerobit?host=/cloudsql/p:asia-northeast1:zerobit-db");
  });
});

describe("ホームの警告の計算", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const run = (minutesAgo: number, mb: number) => ({
    finishedAt: new Date(now.getTime() - minutesAgo * 60_000),
    bytes: Math.round(mb * 1024 * 1024),
  });

  it("まだ一度も成功していなければ「止まっている」", () => {
    expect(backupWarnings([], now)).toEqual({ lastSuccessAt: null, stale: true, sizeJump: null });
  });

  it("最後の成功から90分までは止まっていない、過ぎたら止まっている", () => {
    expect(backupWarnings([run(90, 10)], now).stale).toBe(false);
    expect(backupWarnings([run(91, 10)], now).stale).toBe(true);
  });

  it("ふだん（直前の真ん中の値）の2倍以上に増えた・半分以下に減ったら知らせる", () => {
    const usual = [run(70, 20), run(130, 21), run(190, 19)];
    expect(backupWarnings([run(10, 41), ...usual], now).sizeJump).toEqual({
      usual: 20 * 1024 * 1024,
      latest: Math.round(41 * 1024 * 1024),
    });
    expect(backupWarnings([run(10, 9), ...usual], now).sizeJump?.latest).toBe(Math.round(9 * 1024 * 1024));
    expect(backupWarnings([run(10, 30), ...usual], now).sizeJump).toBeNull();
  });

  it("小さいうちは、倍になっても差が 5MB 未満なら出さない", () => {
    expect(backupWarnings([run(10, 1), run(70, 0.3)], now).sizeJump).toBeNull();
    expect(JUMP_MIN_BYTES).toBe(5 * 1024 * 1024);
  });

  it("復元の試験は、まだ一度もないか、最後の合格から35日を過ぎたら知らせる", () => {
    expect(restoreTestDue(null, now)).toBe(true);
    expect(restoreTestDue(new Date(now.getTime() - 35 * 86_400_000), now)).toBe(false);
    expect(restoreTestDue(new Date(now.getTime() - 35 * 86_400_000 - 60_000), now)).toBe(true);
  });

  it("真ん中の値と MB の表示", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3);
    expect(megabytes(1.25 * 1024 * 1024)).toBe("1.3MB");
  });
});

describe.skipIf(!BACKUP_URL)("バックアップを1回とる（テスト用DB、まねた pg_dump）", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "zb-backup-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await getPool().end();
  });

  const fakeDump: typeof dumpEncrypted = async ({ snapshot, file }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, `snapshot ${snapshot}`, { flag: "wx" });
    return { bytes: 12, sha256: "a".repeat(64) };
  };

  it("置いて、日・月・年の最初のものは写し、記録を成功にする（行数の控えはその瞬間の数）", async () => {
    const target = localTarget(dir);
    const now = new Date("2026-11-16T03:07:00Z"); // 日本時間 12:07
    const r = await runBackup({ url: BACKUP_URL!, recipient: FAKE_RECIPIENT, target, now, env: "test", dump: fakeDump, log: () => {} });
    expect(r.ok).toBe(true);
    expect(r.copies).toEqual(["daily", "monthly", "yearly"]);
    const manifest = JSON.parse(await readFile(join(dir, "db", "hourly", "2026", "11", "16", "120700.json"), "utf8"));
    expect(manifest).toMatchObject({ format: "zerobit-db-backup/1", env: "test", bytes: 12, encryption: "age", recipient: FAKE_RECIPIENT });
    const [{ n }] = await query<{ n: string }>(`SELECT count(*) AS n FROM core.skus`);
    expect(manifest.tables["core.skus"]).toBe(Number(n));
    expect(Object.keys(manifest.tables)).toContain("pii.customer_profiles");
    expect(Object.keys(manifest.tables)).toContain("public.schema_migrations");
    expect(await readFile(join(dir, "db", "daily", "2026", "11", "16.dump.age"), "utf8")).toMatch(/^snapshot /);

    const [run] = await query<{ ok: boolean; mode: string; summary: { bytes: number; object: string; tables: number } }>(
      `SELECT ok, mode, summary FROM core.integration_runs WHERE id = $1`,
      [r.runId],
    );
    expect(run).toMatchObject({ ok: true, mode: "scheduled", summary: { bytes: 12, object: "db/hourly/2026/11/16/120700.dump.age" } });
    expect(run.summary.tables).toBe(Object.keys(manifest.tables).length);
  });

  it("同じ日の2回目は、日の写しは作らない。次の日の最初は日だけ写す", async () => {
    const target = localTarget(dir);
    const second = await runBackup({ url: BACKUP_URL!, recipient: FAKE_RECIPIENT, target, now: new Date("2026-11-16T04:07:00Z"), dump: fakeDump, log: () => {} });
    expect(second.copies).toEqual([]);
    const nextDay = await runBackup({ url: BACKUP_URL!, recipient: FAKE_RECIPIENT, target, now: new Date("2026-11-16T15:07:00Z"), dump: fakeDump, log: () => {} });
    expect(nextDay.copies).toEqual(["daily"]);
    expect(await readdir(join(dir, "db", "daily", "2026", "11"))).toEqual(["16.dump.age", "16.json", "17.dump.age", "17.json"]);
  });

  it("同じ名前がもうあれば上書きせずに失敗として記録する。書き出しに失敗したら何も置かない", async () => {
    const target = localTarget(dir);
    const again = await runBackup({ url: BACKUP_URL!, recipient: FAKE_RECIPIENT, target, now: new Date("2026-11-16T03:07:00Z"), dump: fakeDump, log: () => {} });
    expect(again.ok).toBe(false);

    const broken: typeof dumpEncrypted = async () => {
      throw new Error("pg_dump が失敗しました（1）：connection to postgres://zb_backup:hunter2@localhost failed");
    };
    const failed = await runBackup({ url: BACKUP_URL!, recipient: FAKE_RECIPIENT, target, now: new Date("2026-11-16T05:07:00Z"), dump: broken, log: () => {} });
    expect(failed.ok).toBe(false);
    expect(await target.exists("db/hourly/2026/11/16/140700.dump.age")).toBe(false);
    const [run] = await query<{ ok: boolean; error: string }>(`SELECT ok, error FROM core.integration_runs WHERE id = $1`, [failed.runId]);
    expect(run.ok).toBe(false);
    expect(run.error).toContain("pg_dump が失敗しました");
    expect(run.error).not.toContain("hunter2");
  });

  it("公開鍵がない・形が違うときは、何もせずに止める", async () => {
    await expect(runBackup({ url: BACKUP_URL!, recipient: "", target: localTarget(dir), dump: fakeDump })).rejects.toThrow(/公開鍵/);
    await expect(runBackup({ url: BACKUP_URL!, recipient: "age1bad", target: localTarget(dir), dump: fakeDump })).rejects.toThrow(/公開鍵/);
  });

  it("復元の試験の記録がなければ「まだ」と知らせる（アプリのロールで読める）", async () => {
    const r = await getRestoreTestStatus();
    expect(r.due).toBe(true);
  });

  it("ホームの警告は、最後に成功した時刻をアプリのロールで読める", async () => {
    const w = await getBackupWarnings(); // 記録の時刻は本当の今（finished_at = now()）
    expect(w.lastSuccessAt).not.toBeNull();
    expect(w.stale).toBe(false);
  });

  it.skipIf(!HAS_TOOLS)("本当に pg_dump して age で暗号化し、鍵で戻すと pg_restore で中身の一覧が出る", async () => {
    const keyFile = join(dir, "key.txt");
    const gen = spawnSync("age-keygen", ["-o", keyFile], { encoding: "utf8" });
    expect(gen.status).toBe(0);
    const recipient = gen.stderr.match(/age1[0-9a-z]+/)![0];
    const target = localTarget(join(dir, "real"));
    const r = await runBackup({ url: BACKUP_URL!, recipient, target, now: new Date("2026-11-20T01:00:00Z"), log: () => {} });
    expect(r.ok, r.error).toBe(true);

    const encrypted = join(dir, "real", "db", "hourly", "2026", "11", "20", "100000.dump.age");
    expect(await sha256File(encrypted)).toBe(r.sha256);
    expect((await readFile(encrypted)).subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    const plain = join(dir, "real.dump");
    expect(spawnSync("age", ["--decrypt", "-i", keyFile, "-o", plain, encrypted]).status).toBe(0);
    const list = spawnSync("pg_restore", ["--list", plain], { encoding: "utf8" });
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/TABLE DATA core skus/);
    expect(list.stdout).toMatch(/TABLE DATA pii customer_profiles/);
    expect(list.stdout).toMatch(/TABLE DATA audit log/);
  });
});
