import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, googleConfig, safeNext, type OAuthStart } from "@/lib/auth/google";
import { OAUTH_COOKIE, SESSION_COOKIE } from "@/lib/auth/session";
import { loginWithGoogle } from "@/lib/auth/store";

// Google の画面から戻ってきたとき。state を照らし合わせ、ID トークンを確かめて、社内の人ならログインさせる
export async function GET(request: NextRequest) {
  const config = googleConfig();
  // Cloud Run などの裏では request.url が内部の住所になるので、設定した APP_URL を基準にする
  const base = config?.appUrl ?? request.url;
  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, base));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/auth" });
    return res;
  };

  if (!config) return fail("google_not_configured");

  const start = readStart(request.cookies.get(OAUTH_COOKIE)?.value);
  const params = request.nextUrl.searchParams;
  if (params.get("error")) return fail("google_cancelled");
  const code = params.get("code");
  if (!start || !code || params.get("state") !== start.state) return fail("google_expired");

  const checked = await exchangeCode(config, code, start);
  if (!checked.ok) {
    console.warn(`Googleログインを断りました: ${checked.reason}`);
    return fail("google_denied");
  }
  const issued = await loginWithGoogle(checked.email);
  if (!issued) return fail("not_registered");

  const res = NextResponse.redirect(new URL(safeNext(start.next), base));
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/auth" });
  res.cookies.set(SESSION_COOKIE, issued.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: issued.expiresAt,
  });
  return res;
}

function readStart(raw: string | undefined): OAuthStart | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<OAuthStart>;
    if (typeof v.state !== "string" || typeof v.nonce !== "string" || typeof v.verifier !== "string") return null;
    return { state: v.state, nonce: v.nonce, verifier: v.verifier, next: safeNext(v.next) };
  } catch {
    return null;
  }
}
