import { createHash, randomBytes } from "node:crypto";

// Google Workspace でのログイン（OpenID Connect、認可コード＋PKCE）。
// ID トークンは Google のトークン窓口から HTTPS で直接受け取るので、署名の代わりに通信の確かさで信頼し、
// 中身（発行元・宛先・期限・nonce・ドメイン・メール確認済み）を必ず確かめる。
// 参考: https://developers.google.com/identity/openid-connect/openid-connect#obtainuserinfo

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  /** Workspace のドメイン（例: zerobit.co.jp）。このドメインのアカウントだけ通す */
  domain: string;
  /** この画面のURL（例: http://localhost:3000）。Google に登録したリダイレクトURIの元 */
  appUrl: string;
};

/** 環境変数から設定を読む。足りなければ null（ログイン画面で「未設定」と出す） */
export function googleConfig(env: Record<string, string | undefined> = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const domain = env.AUTH_ALLOWED_DOMAIN?.trim().toLowerCase();
  const appUrl = (env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  if (!clientId || !clientSecret || !domain) return null;
  return { clientId, clientSecret, domain, appUrl };
}

export function redirectUri(config: GoogleConfig): string {
  return `${config.appUrl}/auth/callback`;
}

/** ログイン開始のたびに作る使い捨ての値（Cookie に入れて、戻ってきたときに照らし合わせる） */
export type OAuthStart = { state: string; nonce: string; verifier: string; next: string };

export function newOAuthStart(next: string): OAuthStart {
  const r = () => randomBytes(32).toString("base64url");
  return { state: r(), nonce: r(), verifier: r(), next };
}

export function authorizeUrl(config: GoogleConfig, start: OAuthStart): string {
  const challenge = createHash("sha256").update(start.verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(config),
    response_type: "code",
    scope: "openid email profile",
    state: start.state,
    nonce: start.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    hd: config.domain, // Google の画面で会社のアカウントを選ばせる（確認は下の checkIdToken で行う）
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export type IdClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nonce?: unknown;
  hd?: unknown;
  email?: unknown;
  email_verified?: unknown;
};

export type ClaimCheck = { ok: true; email: string } | { ok: false; reason: string };

/** ID トークンの中身を確かめる（時刻は秒） */
export function checkIdToken(
  claims: IdClaims,
  expect: { clientId: string; nonce: string; domain: string; nowSec: number },
): ClaimCheck {
  if (typeof claims.iss !== "string" || !ISSUERS.includes(claims.iss)) return { ok: false, reason: "発行元が違う" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.clientId)) return { ok: false, reason: "宛先が違う" };
  if (typeof claims.exp !== "number" || claims.exp <= expect.nowSec) return { ok: false, reason: "期限切れ" };
  if (claims.nonce !== expect.nonce) return { ok: false, reason: "nonce が違う" };
  if (claims.hd !== expect.domain) return { ok: false, reason: "会社のアカウントではない" };
  if (claims.email_verified !== true) return { ok: false, reason: "メールが確認されていない" };
  if (typeof claims.email !== "string") return { ok: false, reason: "メールがない" };
  const email = claims.email.toLowerCase();
  if (!email.endsWith(`@${expect.domain}`)) return { ok: false, reason: "会社のアカウントではない" };
  return { ok: true, email };
}

export function decodeJwtPayload(jwt: string): IdClaims {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("ID トークンの形が違います");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as IdClaims;
}

/** 認可コードを ID トークンに替えて、中身を確かめる */
export async function exchangeCode(config: GoogleConfig, code: string, start: OAuthStart): Promise<ClaimCheck> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri(config),
      grant_type: "authorization_code",
      code_verifier: start.verifier,
    }),
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, reason: `トークン窓口が ${res.status} を返した` };
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) return { ok: false, reason: "ID トークンがない" };
  return checkIdToken(decodeJwtPayload(body.id_token), {
    clientId: config.clientId,
    nonce: start.nonce,
    domain: config.domain,
    nowSec: Math.floor(Date.now() / 1000),
  });
}

/** ログイン後に戻る先。自分の画面の中だけ（外のサイトへ飛ばされないように） */
export function safeNext(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string") return fallback;
  // ブラウザは URL 中のタブ・改行を消し、\ を / とみなすので、それも外へ飛ぶ道になる
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  if (raw.startsWith("/login") || raw.startsWith("/auth/")) return fallback;
  return raw;
}
