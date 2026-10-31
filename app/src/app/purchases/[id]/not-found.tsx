import Link from "next/link";

export default function PurchaseNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-bold">その仕入れは見つかりません</h1>
      <Link href="/purchases" className="text-blue-800 hover:underline">
        仕入れの一覧に戻る
      </Link>
    </main>
  );
}
