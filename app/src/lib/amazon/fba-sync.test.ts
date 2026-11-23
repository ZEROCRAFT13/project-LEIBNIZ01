// FBA の在庫と販売の取り込み（まねた SP-API と、ダミーデータの DB）。
// ZB-G5060-R5 は FBA（ZB-G5060-R5-FBA）、ZB-G5070-R7 は両方（ZB-G5070-R7-FBA と -FBM）。db/seeds/0005_dev_amazon.sql
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFbaSyncHealth, inventoryBySku, salesByDay, syncFbaInventory } from "@/lib/amazon/fba-sync";
import type { FbaInventoryItem } from "@/lib/amazon/sp-api";
import { getPool, query } from "@/lib/db";
import { getRestockRows } from "@/lib/fba-restock";
import { addDays } from "@/lib/fba-restock-calc";
import { todayJst } from "@/lib/format";
import { fakeOrder } from "@/test/amazon-fixtures";

let r5: number;
let r7: number;
const now = new Date();
const today = todayJst(now);
const daysAgo = (n: number) => new Date(`${addDays(today, -n)}T12:00:00+09:00`).toISOString();

const inv = (sellerSku: string, fulfillable: number, inbound = 0): FbaInventoryItem => ({
  sellerSku,
  inventoryDetails: { fulfillableQuantity: fulfillable, inboundShippedQuantity: inbound },
});

beforeAll(async () => {
  r5 = (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5060-R5'"))[0].id;
  r7 = (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'"))[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("まとめ方（DB を使わない）", () => {
  const listings = [
    { sellerSku: "A-FBA", skuId: 1, fulfillment: "fba" as const },
    { sellerSku: "A-FBM", skuId: 1, fulfillment: "fbm" as const },
    { sellerSku: "B-FBA", skuId: 2, fulfillment: "fba" as const },
  ];

  it("販売は FBA・自社出荷を機種ごとに合わせ、日本時間の日付で数える。取り消し・未登録の出品は数えない", () => {
    const r = salesByDay(
      [
        fakeOrder({ orderId: "503-0000001-0000101", createdTime: "2026-11-20T15:30:00Z", fulfilledBy: "AMAZON", items: [{ sellerSku: "A-FBA", qty: 2, unitPrice: "100.00" }] }),
        fakeOrder({ orderId: "503-0000001-0000102", createdTime: "2026-11-21T01:00:00Z", items: [{ sellerSku: "A-FBM", qty: 1, unitPrice: "150.00" }] }),
        fakeOrder({ orderId: "503-0000001-0000103", createdTime: "2026-11-21T02:00:00Z", status: "CANCELLED", items: [{ sellerSku: "A-FBA", qty: 5, unitPrice: "1.00" }] }),
        fakeOrder({ orderId: "503-0000001-0000104", createdTime: "2026-11-21T03:00:00Z", items: [{ sellerSku: "OLD-SKU", qty: 1, unitPrice: "1.00" }] }),
      ],
      listings,
    );
    expect(r.rows).toEqual([{ date: "2026-11-21", skuId: 1, units: 3, amount: 350 }]); // 15:30Z は日本時間の 21日 0:30
    expect(r.unknown).toEqual(["OLD-SKU"]);
    expect(r.orders).toBe(2);
  });

  it("在庫は FBA の出品だけを機種ごとに足す。在庫のある未登録の出品は数えて知らせる", () => {
    const r = inventoryBySku([inv("A-FBA", 3, 2), inv("B-FBA", 1), inv("A-FBM", 9), inv("GONE", 0), inv("NEW", 4)], listings);
    expect([...r.bySku]).toEqual([
      [1, { fulfillable: 3, inbound: 2, reserved: 0, unfulfillable: 0 }],
      [2, { fulfillable: 1, inbound: 0, reserved: 0, unfulfillable: 0 }],
    ]);
    expect(r.unknown).toEqual(["A-FBM", "NEW"]);
  });
});

describe("取り込む（テスト用 DB）", () => {
  it("FBA の機種ごとに在庫を記録し、直近31日の販売を作り直す。組立を始める期限が出る", async () => {
    const calls: { createdAfter?: Date; merchantOnly: boolean }[] = [];
    const api = {
      async getFbaInventory() {
        return [inv("ZB-G5070-R7-FBA", 4, 1)]; // R5 は行がない＝0台
      },
      async searchOrders(p: { createdAfter?: Date; merchantOnly: boolean }) {
        calls.push(p);
        // R7 が 14日で 7台（1日 0.5台）、R5 が 14日で 14台（1日 1台）
        return [
          ...Array.from({ length: 7 }, (_, i) =>
            fakeOrder({ orderId: `503-0000008-00001${String(i).padStart(2, "0")}`, createdTime: daysAgo(i * 2 + 1), fulfilledBy: "AMAZON", items: [{ sellerSku: "ZB-G5070-R7-FBA", qty: 1, unitPrice: "349800.00" }] }),
          ),
          ...Array.from({ length: 14 }, (_, i) =>
            fakeOrder({ orderId: `503-0000008-00002${String(i).padStart(2, "0")}`, createdTime: daysAgo(i + 1), fulfilledBy: "AMAZON", items: [{ sellerSku: "ZB-G5060-R5-FBA", qty: 1, unitPrice: "199800.00" }] }),
          ),
          fakeOrder({ orderId: "503-0000008-0000300", createdTime: daysAgo(0), fulfilledBy: "AMAZON", items: [{ sellerSku: "ZB-G5060-R5-FBA", qty: 5, unitPrice: "199800.00" }] }),
        ];
      },
    };
    const r = await syncFbaInventory(api, "manual", now);
    expect(r).toMatchObject({ ok: true, summary: { skus: 2, orders: 22, unitsSold: 26, unknownListings: 0 } });
    expect(calls[0].merchantOnly).toBe(false);
    expect(todayJst(calls[0].createdAfter!)).toBe(addDays(today, -30));

    const [snap] = await query<{ fulfillable: number; inbound: number }>(
      `SELECT fulfillable, inbound FROM core.fba_inventory_snapshots WHERE sku_id = $1 ORDER BY captured_at DESC LIMIT 1`,
      [r7],
    );
    expect(snap).toEqual({ fulfillable: 4, inbound: 1 });
    const [m] = await query<{ units: number; amount: number }>(
      `SELECT sum(units_ordered) AS units, sum(sales_amount) AS amount FROM core.sku_daily_metrics WHERE sku_id = $1 AND channel = 'amazon'`,
      [r5],
    );
    expect(m).toEqual({ units: 19, amount: 199800 * 19 });

    const { rows } = await getRestockRows(now);
    // 組立中・出荷待ちの個体（ほかのテストで作ったもの）も在庫に足して数える
    const r5row = rows.find((x) => x.skuId === r5)!;
    // 今日の5台は数えない（途中なので）。1日1台
    expect(r5row).toMatchObject({ fulfillable: 0, inbound: 0, perDay: 1, supply: r5row.pipeline, daysLeft: r5row.pipeline });
    expect(r5row.suggestQty).toBe(Math.max(0, 40 - r5row.pipeline));
    const r7row = rows.find((x) => x.skuId === r7)!;
    // 1日0.5台、在庫5＋組立中・出荷待ち
    expect(r7row).toMatchObject({ fulfillable: 4, inbound: 1, perDay: 0.5, supply: 5 + r7row.pipeline });
    expect(r7row.daysLeft).toBe(Math.floor((5 + r7row.pipeline) / 0.5));
    expect(r7row.startBy).toBe(addDays(today, r7row.daysLeft! - 10));
  });

  it("期限が近い機種は工場長の ToDo になり、足りたら自動で閉じる", async () => {
    // R5 の組立中・出荷待ちの数に合わせて、確実に「今すぐ」になる売れ方にする（1日 その数＋1 台）
    const { rows } = await getRestockRows(now);
    const pipeline = rows.find((x) => x.skuId === r5)!.pipeline;
    const perDay = pipeline + 1;
    const selling = {
      async getFbaInventory() {
        return [];
      },
      async searchOrders() {
        return Array.from({ length: 14 }, (_, i) =>
          fakeOrder({ orderId: `503-0000008-00004${String(i).padStart(2, "0")}`, createdTime: daysAgo(i + 1), fulfilledBy: "AMAZON", items: [{ sellerSku: "ZB-G5060-R5-FBA", qty: perDay, unitPrice: "1.00" }] }),
        );
      },
    };
    const r = await syncFbaInventory(selling, "incremental", now);
    expect(r).toMatchObject({ ok: true });
    const task = async () =>
      (
        await query<{ title: string; status: string; role_code: string; due_at: Date; delay_reason: string | null }>(
          `SELECT title, status, role_code, due_at, delay_reason FROM core.tasks WHERE source_ref = $1 ORDER BY id DESC LIMIT 1`,
          [`fba-restock:sku:${r5}`],
        )
      )[0];
    expect(await task()).toMatchObject({ title: "FBA 補充：ZB-G5060-R5 の組立を始める", status: "todo", role_code: "factory_manager" });
    // 2回目は作らない
    const again = await syncFbaInventory(selling, "incremental", now);
    expect(again.ok && again.summary.tasks?.created).toBe(0);
    // 在庫が十分に入ったら閉じる（期限を過ぎていれば理由つき）
    const stocked = { ...selling, async getFbaInventory() { return [inv("ZB-G5060-R5-FBA", 500)]; } };
    const r3 = await syncFbaInventory(stocked, "incremental", now);
    expect(r3.ok && r3.summary.tasks?.closed).toBeGreaterThanOrEqual(1);
    const t = await task();
    expect(t.status).toBe("done");
  });

  it("取り消しが増えたら、次の取り込みで販売が減る（期間を作り直す）", async () => {
    const api = {
      async getFbaInventory() {
        return [];
      },
      async searchOrders() {
        return [];
      },
    };
    expect(await syncFbaInventory(api, "manual", now)).toMatchObject({ ok: true, summary: { orders: 0 } });
    const [m] = await query<{ units: number }>(
      `SELECT coalesce(sum(units_ordered), 0) AS units FROM core.sku_daily_metrics WHERE sku_id = $1 AND channel = 'amazon' AND metric_date >= $2`,
      [r5, addDays(today, -30)],
    );
    expect(Number(m.units)).toBe(0);
  });

  it("失敗したら記録して ToDo で知らせ、成功したら閉じる", async () => {
    const broken = {
      async getFbaInventory(): Promise<FbaInventoryItem[]> {
        throw new Error("Amazon への問い合わせに失敗しました（403 Unauthorized）。権限がないか、アプリの承認が切れています。");
      },
      async searchOrders() {
        return [];
      },
    };
    expect(await syncFbaInventory(broken, "incremental", now)).toMatchObject({ ok: false, error: expect.stringContaining("403") });
    const open = () =>
      query<{ status: string }>(`SELECT status FROM core.tasks WHERE source_ref = 'sync:amazon_fba' ORDER BY id DESC LIMIT 1`).then((x) => x[0]?.status);
    expect(await open()).toBe("todo");
    expect((await getFbaSyncHealth(true)).lastError).toContain("403");
    const ok = { async getFbaInventory() { return []; }, async searchOrders() { return []; } };
    expect(await syncFbaInventory(ok, "incremental", now)).toMatchObject({ ok: true });
    expect(await open()).toBe("done");
    expect(await getFbaSyncHealth(true)).toMatchObject({ lastError: null, stale: false });
  });
});
