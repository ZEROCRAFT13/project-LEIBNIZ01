import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZERO-BIT 基幹システム",
  description: "在庫・個体トレース・受信箱・会計をまとめる社内システム",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
