import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // 本番はコンテナ（Cloud Run）で動かす。必要なファイルだけを .next/standalone にまとめる
  output: "standalone",
  // リポジトリの一番上にも package.json があるので、まとめる範囲は app/ にする
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // 書類のアップロード（1ファイル20MBまで。送るときの余白を足す）
    serverActions: { bodySizeLimit: "21mb" },
    proxyClientMaxBodySize: "21mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
