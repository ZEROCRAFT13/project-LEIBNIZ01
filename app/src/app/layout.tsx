import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZERO-BIT 基幹システム",
  description: "在庫・個体トレース・受信箱・会計をまとめる社内システム",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-stone-100 text-stone-900">
        <header className="bg-stone-900 text-white">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <Link href="/" className="font-mono text-lg font-medium tracking-wider">
              ZERO-BIT
            </Link>
            <nav aria-label="メインメニュー" className="flex gap-1 text-sm">
              <Link href="/" className="rounded px-3 py-2 text-stone-300 hover:bg-stone-800 hover:text-white">
                ホーム
              </Link>
              <Link href="/trace" className="rounded px-3 py-2 text-stone-300 hover:bg-stone-800 hover:text-white">
                個体トレース
              </Link>
              <Link href="/assembly" className="rounded px-3 py-2 text-stone-300 hover:bg-stone-800 hover:text-white">
                組立
              </Link>
            </nav>
            {process.env.NODE_ENV !== "production" && (
              <span className="ml-auto rounded bg-amber-200 px-2 py-1 text-xs font-medium text-amber-950">
                開発中・ログイン未実装（ダミーデータ）
              </span>
            )}
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
