import { NextResponse, type NextRequest } from "next/server";

// ログインの Cookie がなければ、ログイン画面へ回す（早めの振り分けだけ）。
// 本当の確認（鍵が有効か・権限があるか）は、各画面と処理の require〜 で DB を見て行う。
export function proxy(request: NextRequest) {
  if (request.cookies.has("zb_session")) return NextResponse.next();
  const next = request.nextUrl.pathname + request.nextUrl.search;
  const url = new URL("/login", request.url);
  if (next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

export const config = {
  // ログイン画面・Google から戻る窓口・画像や部品のファイルは、ログインなしで開ける
  matcher: ["/((?!login|auth/|_next/static|_next/image|favicon\\.ico).*)"],
};
