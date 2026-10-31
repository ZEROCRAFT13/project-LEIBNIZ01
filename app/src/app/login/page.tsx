import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PinPad } from "@/components/auth/pin-pad";
import { Card, Loading } from "@/components/ui";
import { googleConfig, safeNext } from "@/lib/auth/google";
import { canAssemble, devLoginEnabled, getDevice, getViewer } from "@/lib/auth/session";
import { listDevLoginUsers, listPinWorkers } from "@/lib/auth/store";
import { devLoginAction } from "./actions";

export const metadata: Metadata = { title: "ログイン | ZERO-BIT" };

const errors: Record<string, string> = {
  google_not_configured:
    "Googleログインの設定がまだです。app/.env.local に GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・AUTH_ALLOWED_DOMAIN を入れてください。",
  google_cancelled: "Googleのログインが取り消されました。",
  google_expired: "ログインの途中で時間が切れました。もう一度「Googleでログイン」を押してください。",
  google_denied: "会社のGoogleアカウント（Workspace）でログインしてください。",
  not_registered: "このアカウントはまだ登録されていません。代表に登録を頼んでください。",
  no_role: "組立の役割がないため、組立画面を使えません。代表に確認してください。",
};

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-8">
      <Suspense fallback={<Loading />}>
        <LoginPanel searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LoginPanel({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const [sp, viewer, device] = await Promise.all([searchParams, getViewer(), getDevice()]);
  const next = safeNext(sp.next);
  if (viewer?.kind === "user") redirect(next);
  if (viewer?.kind === "worker" && canAssemble(viewer)) redirect("/assembly");

  const error = typeof sp.error === "string" ? errors[sp.error] : undefined;
  const notice = error && (
    <p role="alert" className="rounded-md bg-red-100 px-4 py-3 text-red-900">
      {error}
    </p>
  );

  // 組立用に登録した端末: 名前とPINでログイン
  if (device) {
    const workers = await listPinWorkers();
    return (
      <>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">組立のログイン</h1>
          <p className="text-sm text-stone-600">端末：{device.name}</p>
        </div>
        {sp.enrolled === "1" && (
          <p role="status" className="rounded-md bg-green-100 px-4 py-3 text-green-950">
            この端末を「{device.name}」として登録しました。名前を押してPINを入れてください。
          </p>
        )}
        {notice}
        <PinPad workers={workers} />
        <p className="pt-4 text-xs text-stone-500">
          代表・社員の方は、この共用の端末ではなく自分のPCやスマホからGoogleでログインしてください。
        </p>
      </>
    );
  }

  // それ以外: 代表・社員は Google でログイン
  const devUsers = devLoginEnabled() ? await listDevLoginUsers() : [];
  return (
    <>
      <h1 className="text-2xl font-bold">ログイン</h1>
      {notice}
      <Card>
        <div className="flex flex-col gap-3 p-5">
          <a
            href={`/auth/google?next=${encodeURIComponent(next)}`}
            className="flex h-14 items-center justify-center rounded-md bg-blue-800 text-lg font-bold text-white hover:bg-blue-900"
          >
            Googleでログイン
          </a>
          <p className="text-sm text-stone-600">会社のGoogleアカウント（Workspace）で入ります。</p>
          {!googleConfig() && (
            <p className="text-xs text-amber-900">※ Googleログインの設定がまだです（README の「ログインの準備」）。</p>
          )}
        </div>
      </Card>

      {devUsers.length > 0 && (
        <Card title="開発用ログイン">
          <div className="flex flex-col gap-2 p-5">
            <p className="text-xs text-stone-600">
              開発中（ZB_DEV_LOGIN=1）だけ出ます。本番のビルドでは出ません。
            </p>
            {devUsers.map((u) => (
              <form key={u.id} action={devLoginAction}>
                <input type="hidden" name="userId" value={u.id} />
                <input type="hidden" name="next" value={next} />
                <button
                  type="submit"
                  className="h-11 w-full rounded-md border border-amber-400 bg-amber-50 px-4 text-left hover:border-amber-600"
                >
                  {u.name} としてログイン
                </button>
              </form>
            ))}
          </div>
        </Card>
      )}

      <Link href="/login/device" className="text-sm text-blue-800 hover:underline">
        組立担当の方：この端末を組立用に登録する
      </Link>
    </>
  );
}
