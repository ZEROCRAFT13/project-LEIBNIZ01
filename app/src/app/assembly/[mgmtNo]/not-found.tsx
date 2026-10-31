import Link from "next/link";

export default function AssemblyUnitNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-bold">その管理番号の個体は見つかりません</h1>
      <p className="text-stone-700">シールの番号を確かめて、もう一度読んでください。</p>
      <Link href="/assembly" className="text-blue-800 hover:underline">
        組立のトップに戻る
      </Link>
    </main>
  );
}
