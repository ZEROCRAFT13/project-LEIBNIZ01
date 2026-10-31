import Link from "next/link";

export default function DraftNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-bold">その下書きは見つかりません</h1>
      <Link href="/purchases/drafts" className="text-blue-800 hover:underline">
        下書きの一覧に戻る
      </Link>
    </main>
  );
}
