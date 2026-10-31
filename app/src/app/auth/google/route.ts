import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl, googleConfig, newOAuthStart, safeNext } from "@/lib/auth/google";
import { OAUTH_COOKIE } from "@/lib/auth/session";

// 「Googleでログイン」を押したとき。使い捨ての値を Cookie に入れて、Google の画面へ送る
export async function GET(request: NextRequest) {
  const config = googleConfig();
  if (!config) return NextResponse.redirect(new URL("/login?error=google_not_configured", request.url));

  const start = newOAuthStart(safeNext(request.nextUrl.searchParams.get("next")));
  const res = NextResponse.redirect(authorizeUrl(config, start));
  res.cookies.set(OAUTH_COOKIE, Buffer.from(JSON.stringify(start)).toString("base64url"), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/auth",
    maxAge: 600, // 10分以内に戻ってこなければやり直し
  });
  return res;
}
