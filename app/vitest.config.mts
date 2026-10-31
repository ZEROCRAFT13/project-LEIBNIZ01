import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// テストは リポジトリの一番上で `npm test` から動かす
// （アプリ用のテストDBを作り直し、DATABASE_URL を渡してから vitest を起動する）
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // "server-only" はテストでは読み込めないので空のファイルに置き換える
      "server-only": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
  },
});
