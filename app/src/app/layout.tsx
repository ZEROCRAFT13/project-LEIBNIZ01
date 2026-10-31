import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccountNav } from "@/components/account-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZERO-BIT 基幹システム",
  description: "在庫・個体トレース・受信箱・会計をまとめる社内システム",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-stone-100 text-stone-900">
        <header className="bg-stone-900 text-white print:hidden">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <Link href="/" className="font-mono text-lg font-medium tracking-wider">
              ZERO-BIT
            </Link>
            {process.env.NODE_ENV !== "production" && (
              <span className="rounded bg-amber-200 px-2 py-1 text-xs font-medium text-amber-950">開発中（ダミーデータ）</span>
            )}
            <Suspense>
              <AccountNav />
            </Suspense>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
