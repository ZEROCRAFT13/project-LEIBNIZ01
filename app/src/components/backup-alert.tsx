import { megabytes } from "@/lib/backup-calc";
import { backupExpected, getBackupWarnings, getRestoreTestStatus } from "@/lib/backup-health";
import { ymdHm } from "@/lib/format";

/**
 * データベースのバックアップが止まった・大きさが急に変わったら出す警告と、
 * 毎月の復元の試験の知らせ（ホーム。代表・管理する人だけに見せる）
 */
export async function BackupAlert() {
  if (!backupExpected()) return null;
  const [w, restore] = await Promise.all([getBackupWarnings(), getRestoreTestStatus()]);
  return (
    <>
      {(w.stale || w.sizeJump) && <BackupWarning w={w} />}
      {restore.due && (
        <p className="rounded-md border border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <span className="font-bold">今月の復元の試験がまだです</span>
          （最後に合格：{restore.lastPassedAt ? ymdHm(restore.lastPassedAt) : "まだ一度もありません"}）。Cloud Shell で
          infra/restore-test.sh を動かし、大阪のバックアップから戻せることを確かめてください（docs/deploy.md「毎月の復元の試験」。10分ほど）。
        </p>
      )}
    </>
  );
}

function BackupWarning({ w }: { w: Awaited<ReturnType<typeof getBackupWarnings>> }) {
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-md border-2 border-red-600 bg-red-50 px-4 py-3 text-sm text-red-900">
      {w.stale && (
        <p>
          <span className="font-bold">データベースのバックアップが止まっています</span>
          （最後に成功：{w.lastSuccessAt ? ymdHm(w.lastSuccessAt) : "まだ一度もありません"}）。Google Cloud の Cloud Run
          のジョブ「zerobit-backup」の記録を確かめてください（docs/deploy.md「困ったとき」）。
        </p>
      )}
      {w.sizeJump && (
        <p>
          <span className="font-bold">バックアップの大きさが急に変わりました</span>
          （ふだん約 {megabytes(w.sizeJump.usual)} → 今回 {megabytes(w.sizeJump.latest)}
          ）。大量の登録や取り込みをした覚えがなければ、データが書き換えられたり消されたりしていないか確かめてください。
        </p>
      )}
    </div>
  );
}
