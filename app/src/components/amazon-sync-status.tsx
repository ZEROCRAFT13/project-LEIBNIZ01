import Link from "next/link";
import { getSyncHealth } from "@/lib/amazon/order-sync";
import { spApiConfigFromEnv } from "@/lib/amazon/sp-api";
import { ymdHm } from "@/lib/format";

/** 注文の取り込みが止まっていたら出す警告（ホームと ToDo）。キーが設定されていなければ何も出さない */
export async function AmazonSyncAlert() {
  const h = await getSyncHealth(spApiConfigFromEnv() !== null);
  if (!h.stale) return null;
  return (
    <p role="alert" className="rounded-md border-2 border-red-600 bg-red-50 px-4 py-3 text-sm text-red-900">
      <span className="font-bold">Amazon の自社出荷の注文の取り込みが止まっています</span>
      （最後に成功：{h.lastSuccessAt ? ymdHm(h.lastSuccessAt) : "まだ一度もありません"}）。新しい注文が ToDo に入りません。セラーセントラルで注文を確かめ、
      <Link href="/fbm" className="mx-1 font-bold underline">
        自社出荷
      </Link>
      の画面から取り込み直してください。
    </p>
  );
}
