import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-bold">その仕入先は見つかりません</h1>
      <Link href="/settings/suppliers" className="text-blue-800 hover:underline">
        一覧に戻る
      </Link>
    </main>
  );
}
