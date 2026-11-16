// データベースのバックアップの様子から、ホームに出す警告を決める（計算だけ。DB は読まない）
//   止まっている … 最後に成功してから90分を過ぎた（1時間ごとに動くので、1回抜けたら気づく）
//   大きさが急に変わった … 直前までの成功（最大24回）の真ん中の値より、2倍以上に増えた・半分以下に減った
//     （ウイルスでデータが暗号化されると縮まなくなって増える。消されると減る。仕様書8章）
//     小さいうちは少しの登録でも倍になるので、差が 5MB 未満なら出さない

export const STALE_MINUTES = 90;
export const JUMP_RATIO = 2;
export const JUMP_MIN_BYTES = 5 * 1024 * 1024;
export const COMPARE_RUNS = 24;

export type BackupRun = { finishedAt: Date; bytes: number };

export type BackupWarnings = {
  /** 最後に成功した時刻（まだなければ null） */
  lastSuccessAt: Date | null;
  stale: boolean;
  /** 大きさが急に変わったとき：比べた値（真ん中）と今回 */
  sizeJump: { usual: number; latest: number } | null;
};

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** 成功したバックアップ（新しい順）から警告を決める */
export function backupWarnings(successes: BackupRun[], now: Date): BackupWarnings {
  const [latest, ...before] = successes;
  if (!latest) return { lastSuccessAt: null, stale: true, sizeJump: null };
  const stale = now.getTime() - latest.finishedAt.getTime() > STALE_MINUTES * 60 * 1000;
  const previous = before.slice(0, COMPARE_RUNS).map((r) => r.bytes);
  let sizeJump: BackupWarnings["sizeJump"] = null;
  if (previous.length > 0) {
    const usual = median(previous);
    const changed = latest.bytes >= usual * JUMP_RATIO || latest.bytes * JUMP_RATIO <= usual;
    if (changed && Math.abs(latest.bytes - usual) >= JUMP_MIN_BYTES) sizeJump = { usual, latest: latest.bytes };
  }
  return { lastSuccessAt: latest.finishedAt, stale, sizeJump };
}

/** 復元の試験は毎月。最後の合格から35日を過ぎたら（まだ一度もなければ）知らせる */
export const RESTORE_TEST_DAYS = 35;

export function restoreTestDue(lastPassedAt: Date | null, now: Date): boolean {
  if (!lastPassedAt) return true;
  return now.getTime() - lastPassedAt.getTime() > RESTORE_TEST_DAYS * 24 * 60 * 60 * 1000;
}

/** 画面に出す大きさ（MB、小数1けた） */
export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
