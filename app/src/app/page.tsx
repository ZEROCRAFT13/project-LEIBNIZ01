// 仮のトップページ。ホーム（コントロールパネル）はフェーズ1で作る
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-24">
      <h1 className="text-2xl font-bold">ZERO-BIT 基幹システム</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        開発中です。次に作るのは「個体トレース」と「組立スマホ画面」です。
      </p>
    </main>
  );
}
