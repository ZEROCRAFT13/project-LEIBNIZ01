import Link from "next/link";
import { Suspense } from "react";
import { Loading } from "@/components/ui";
import { countOpenTasks } from "@/lib/tasks";
import { canAssemble, canDocuments, canInspect, canManage, canPurchase, requireUser } from "@/lib/auth/session";

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
  const tasks = await countOpenTasks(viewer.roles);
  const items = [
    {
      href: "/trace",
      title: "個体トレース",
      text: "管理番号・注文番号・部品のシリアルから、使った部品・仕入れ・組立・出荷・保証・修理の履歴を見る",
    },
    ...(canPurchase(viewer)
      ? [
          {
            href: "/purchases",
            title: "仕入れ・入荷",
            text: "ショップで買った部品を登録し、届いたら箱のシリアルを読んで在庫に入れる（元箱の棚番も記録）",
          },
        ]
      : []),
    ...(canDocuments(viewer)
      ? [
          {
            href: "/documents",
            title: "書類",
            text: "領収書・保証書・納品書を取り込みフォルダやアップロードから集め、仕入れにひもづけて保管する",
          },
        ]
      : []),
    ...(canAssemble(viewer)
      ? [
          {
            href: "/assembly",
            title: "組立",
            text: "管理番号を発行し、部品のバーコードを読んで取り付けを記録する（組立担当のスマホ・タブレット用）",
          },
          {
            href: "/labels",
            title: "管理番号シール",
            text: "発行した管理番号の QR シールを PT-P700（24mm テープ）で刷る。本体と箱に1枚ずつ",
          },
        ]
      : []),
    ...(canInspect(viewer)
      ? [
          {
            href: "/inspection",
            title: "検品",
            text: "組み上がった個体を3段階（組立状態・Windows とベンチマーク・出荷直前）で確かめ、写真と測った値を残す",
          },
        ]
      : []),
    ...(canManage(viewer)
      ? [
          {
            href: "/fba",
            title: "FBA 納品",
            text: "出荷待ちの個体を納品にまとめ、Amazon の出荷の番号と送り状番号を記録する。受領数を入れると FBA 在庫になる",
          },
          {
            href: "/fbm",
            title: "自社出荷",
            text: "Amazon の自社出荷の注文に、出荷待ちの個体を管理番号で結びつけ、送り状番号を入れて発送する",
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
      <Link
        href="/todo"
        className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border-2 px-5 py-4 ${
          tasks.overdue > 0 ? "border-red-600 bg-red-50" : "border-blue-700 bg-white"
        }`}
      >
        <span className="text-lg font-bold">ToDo</span>
        <span>やること {tasks.open}件</span>
        {tasks.overdue > 0 && <span className="font-bold text-red-800">期限を過ぎたもの {tasks.overdue}件</span>}
        <span className="ml-auto text-sm text-blue-800">開く →</span>
      </Link>
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
