import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NewDeviceForm, ReissueButton } from "@/components/settings/forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requireManager } from "@/lib/auth/session";
import { listDevices, type DeviceRow } from "@/lib/auth/store";
import { ymdHm } from "@/lib/format";
import { revokeDeviceAction } from "../actions";

export const metadata: Metadata = { title: "組立用の端末 | ZERO-BIT" };

export default function DevicesPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link href="/settings" className="text-sm text-blue-800 hover:underline">
        ← 設定
      </Link>
      <h1 className="text-2xl font-bold">組立用の端末</h1>
      <Suspense fallback={<Loading />}>
        <Devices />
      </Suspense>
    </main>
  );
}

async function Devices() {
  await requireManager("/settings/devices");
  const devices = await listDevices();

  return (
    <>
      <Card title="新しく登録する">
        <div className="flex flex-col gap-3 p-5">
          <p className="text-sm text-stone-600">
            名前を付けて登録コードを出し、組立台の端末で <span className="font-mono">/login/device</span>{" "}
            を開いてコードを入れます。登録した端末では、バイトが名前とPINでログインできます（12時間で自動ログアウト）。
          </p>
          <NewDeviceForm />
        </div>
      </Card>

      <Card title={`登録済み ${devices.filter((d) => !d.revokedAt).length}台`}>
        {devices.length === 0 ? (
          <p className="px-5 py-4 text-sm text-stone-600">まだありません。</p>
        ) : (
          <ul>
            {devices.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 border-b border-stone-100 px-5 py-4 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{d.name}</span>
                  <DeviceTag device={d} />
                </div>
                <p className="text-sm text-stone-600">
                  作成 {ymdHm(d.createdAt)}（{d.registeredBy}）・登録 {ymdHm(d.enrolledAt)}・最後のログイン{" "}
                  {ymdHm(d.lastLoginAt)}
                  {d.revokedAt && `・無効 ${ymdHm(d.revokedAt)}`}
                </p>
                {!d.revokedAt && (
                  <div className="flex flex-wrap items-start gap-4">
                    {!d.enrolledAt && <ReissueButton deviceId={d.id} />}
                    <details className="text-sm">
                      <summary className="cursor-pointer font-bold text-red-800">無効にする</summary>
                      <form action={revokeDeviceAction} className="mt-2 flex flex-col gap-2">
                        <input type="hidden" name="deviceId" value={d.id} />
                        <p className="text-stone-700">
                          この端末ではログインできなくなり、ログイン中の人も切れます。なくしたときはすぐ無効にしてください。
                        </p>
                        <button type="submit" className="h-10 w-fit rounded-md bg-red-700 px-4 font-bold text-white">
                          「{d.name}」を無効にする
                        </button>
                      </form>
                    </details>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function DeviceTag({ device }: { device: DeviceRow }) {
  if (device.revokedAt) return <Tag tone="gray">無効</Tag>;
  if (device.enrolledAt) return <Tag tone="green">使用中</Tag>;
  if (device.codeValid) return <Tag tone="blue">登録コード待ち</Tag>;
  return <Tag tone="amber">コード期限切れ</Tag>;
}
