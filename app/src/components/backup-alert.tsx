import { megabytes } from "@/lib/backup-calc";
import { backupExpected, getBackupWarnings } from "@/lib/backup-health";
import { ymdHm } from "@/lib/format";

/** データベースのバックアップが止まった・大きさが急に変わったら出す警告（ホーム。代表・管理する人だけに見せる） */
export async function BackupAlert() {
  if (!backupExpected()) return null;
  const w = await getBackupWarnings();
  if (!w.stale && !w.sizeJump) return null;
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
