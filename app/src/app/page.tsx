import Link from "next/link";
import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { canAssemble, canManage, requireUser } from "@/lib/auth/session";

// 仮のトップページ。ホーム（コントロールパネル）はフェーズ1の最後に作る
export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold">ZERO-BIT 基幹システム</h1>
      <Suspense fallback={<Loading />}>
        <Menu searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Menu({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const [viewer, { denied }] = await Promise.all([requireUser("/"), searchParams]);
  const items = [
    {
      href: "/trace",
      title: "個体トレース",
      text: "管理番号・注文番号・部品のシリアルから、使った部品・仕入れ・組立・出荷・保証・修理の履歴を見る",
    },
    ...(canAssemble(viewer)
      ? [
          {
            href: "/assembly",
            title: "組立",
            text: "管理番号を発行し、部品のバーコードを読んで取り付けを記録する（組立担当のスマホ・タブレット用）",
          },
        ]
      : []),
    ...(canManage(viewer)
      ? [{ href: "/settings", title: "設定", text: "組立用の端末の登録、バイトの追加とPINの設定" }]
      : []),
  ];

  return (
    <>
      {denied === "1" && (
        <p role="alert" className="rounded-md bg-amber-100 px-4 py-3 text-amber-950">
          その画面を使う役割がありません。必要なら代表に役割を付けてもらってください。
        </p>
      )}
      <ul className="grid gap-4 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
            >
              <span className="font-bold">{i.title}</span>
              <span className="text-sm text-stone-600">{i.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
