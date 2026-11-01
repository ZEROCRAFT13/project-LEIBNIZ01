import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// 定期実行（Cloud Scheduler）からの呼び出しを確かめる。合言葉は環境変数 ZB_JOB_SECRET（32文字以上）。
// 本番では Secret Manager に置く。合言葉そのものはログに出さない。

export function jobSecretOk(header: string | null, secret: string | undefined = process.env.ZB_JOB_SECRET): boolean {
  if (!secret || secret.length < 32 || !header) return false;
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
