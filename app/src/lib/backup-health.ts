import "server-only";
import { backupWarnings, COMPARE_RUNS, restoreTestDue, type BackupWarnings } from "@/lib/backup-calc";
import { query } from "@/lib/db";

// データベースのバックアップの様子（ホームの警告用。読むだけ）
// 本番・検証では、反映のときに ZB_BACKUP_EXPECTED=1 を付ける（開発中は警告を出さない）

export function backupExpected(): boolean {
  return process.env.ZB_BACKUP_EXPECTED === "1";
}

export async function getBackupWarnings(now = new Date()): Promise<BackupWarnings> {
  const rows = await query<{ finishedAt: Date; bytes: string | null }>(
    `SELECT finished_at AS "finishedAt", summary->>'bytes' AS bytes
       FROM core.integration_runs
      WHERE kind = 'db_backup' AND ok
      ORDER BY finished_at DESC
      LIMIT $1`,
    [COMPARE_RUNS + 1],
  );
  return backupWarnings(
    rows.map((r) => ({ finishedAt: r.finishedAt, bytes: Number(r.bytes ?? 0) })),
    now,
  );
}

export type RestoreTestStatus = { lastPassedAt: Date | null; due: boolean };

/** 毎月の復元の試験（infra/restore-test.sh が記録する）の様子 */
export async function getRestoreTestStatus(now = new Date()): Promise<RestoreTestStatus> {
  const [r] = await query<{ lastPassedAt: Date | null }>(
    `SELECT max(finished_at) AS "lastPassedAt" FROM core.integration_runs WHERE kind = 'restore_test' AND ok`,
  );
  return { lastPassedAt: r.lastPassedAt, due: restoreTestDue(r.lastPassedAt, now) };
}
