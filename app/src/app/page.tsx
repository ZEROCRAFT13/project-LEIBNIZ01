import Link from "next/link";

// 仮のトップページ。ホーム（コントロールパネル）はフェーズ1の最後に作る
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold">ZERO-BIT 基幹システム</h1>
      <ul className="grid gap-4 sm:grid-cols-2">
        <li>
          <Link
            href="/trace"
            className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
          >
            <span className="font-bold">個体トレース</span>
            <span className="text-sm text-stone-600">
              管理番号・注文番号・部品のシリアルから、使った部品・仕入れ・組立・出荷・保証・修理の履歴を見る
            </span>
          </Link>
        </li>
        <li>
          <Link
            href="/assembly"
            className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-5 hover:border-blue-700"
          >
            <span className="font-bold">組立</span>
            <span className="text-sm text-stone-600">
              管理番号を発行し、部品のバーコードを読んで取り付けを記録する（組立担当のスマホ・タブレット用）
            </span>
          </Link>
        </li>
      </ul>
    </main>
  );
}
