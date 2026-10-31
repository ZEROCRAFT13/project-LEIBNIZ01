import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// ログインで使う乱数・ハッシュ・PINの確認。DBにもCookieにも依存しないので、そのままテストできる。

/** Cookie に入れる鍵（セッション・端末）。DB にはこれの SHA-256 だけを保存する */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

// ---------------------------------------------------------------------
// 端末の登録コード（8桁の数字。10分だけ有効）
// ---------------------------------------------------------------------

export const ENROLL_CODE_MINUTES = 10;

export function newEnrollCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

/** 「1234-5678」「１２３４ ５６７８」などを 12345678 にそろえる。8桁でなければ null */
export function normalizeEnrollCode(raw: string): string | null {
  const digits = raw.normalize("NFKC").replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}

export function formatEnrollCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// ---------------------------------------------------------------------
// 組立担当の4桁PIN
// ---------------------------------------------------------------------

/** 全角数字も受け付ける */
export function normalizePin(raw: string): string {
  return raw.normalize("NFKC").trim();
}

/** PINとして使えなければ理由を返す（使えれば null） */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "PINは4桁の数字にしてください。";
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return "同じ数字だけのPIN（1111 など）は使えません。";
  const steps = d.slice(1).map((x, i) => x - d[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return "連続した数字のPIN（1234・9876 など）は使えません。";
  }
  return null;
}

// scrypt の設定。4桁は総当たりに弱いので、本当の守りは「5回でロック」と「登録済み端末だけ」。
// ハッシュにするのは、DBの中身が漏れたときにPINがそのまま見えないようにするため。
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** 保存する形: scrypt$N$r$p$salt$hash（salt と hash は base64url） */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pin, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scryptAsync(pin, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
