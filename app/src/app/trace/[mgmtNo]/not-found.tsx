import Link from "next/link";

export default function UnitNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold">その管理番号の個体は見つかりません</h1>
      <p className="text-stone-700">番号を確かめて、もう一度探してください。</p>
      <Link href="/trace" className="text-blue-800 hover:underline">
        個体トレースに戻る
      </Link>
    </main>
  );
}
