import { query } from "@/lib/db";

// 動いているかの確認（ログインなし）。返すのは版とデータベースにつながるかだけ
export async function GET() {
  let db = false;
  try {
    await query("SELECT 1");
    db = true;
  } catch {
    db = false;
  }
  return Response.json({ ok: db, version: process.env.ZB_VERSION ?? "dev", db }, { status: db ? 200 : 503 });
}
