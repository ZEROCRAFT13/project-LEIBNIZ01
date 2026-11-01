// 自社出荷の注文の取り込み（ダミーデータの DB に、まねた SP-API で）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiOrder } from "@/lib/amazon/orders-map";
import { getSyncHealth, syncAmazonOrders } from "@/lib/amazon/order-sync";
import type { OrdersApi } from "@/lib/amazon/sp-api";
import { getPool, query } from "@/lib/db";
import { cancelFbmOrder } from "@/lib/fbm";
import { parseSkuInput } from "@/lib/sku-calc";
import { createSku, setAmazonListings } from "@/lib/skus";
import { listOpenTasks } from "@/lib/tasks";
import { fakeOrder } from "@/test/amazon-fixtures";

const ALL = ["ceo", "factory_manager"];
let owner: number;

/** 決まった注文を返す SP-API。呼ばれた条件も残す */
function fakeApi(pages: () => ApiOrder[]): OrdersApi & { calls: Parameters<OrdersApi["searchOrders"]>[0][] } {
  const calls: Parameters<OrdersApi["searchOrders"]>[0][] = [];
  return {
    calls,
    async searchOrders(p) {
      calls.push(p);
      return pages();
    },
  };
}

const failing: OrdersApi = {
  async searchOrders() {
    throw new Error("Amazon への問い合わせに失敗しました（503）。");
  },
};

const orderRow = (no: string) =>
  query<{ id: number; status: string; source: string; total_amount: number; ship_by: string; amazon_status: string }>(
    `SELECT id, status, source, total_amount, ship_by, amazon_status FROM core.orders WHERE external_order_no = $1`,
    [no],
  ).then((r) => r[0]);
const openTask = async (ref: string) => (await listOpenTasks(ALL)).find((t) => t.sourceRef === ref);

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("新しい注文を取り込む", () => {
  it("自社出荷の注文を登録し、ToDo に「出荷する」を作る。はじめては24時間前から取る", async () => {
    const api = fakeApi(() => [fakeOrder({ orderId: "503-2000000-0000001", shipBy: "2099-01-05T14:59:59Z" })]);
    const r = await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:00:00Z"));
    expect(r).toMatchObject({ ok: true, summary: { fetched: 1, created: 1 } });
    expect(api.calls[0]).toEqual({ lastUpdatedAfter: new Date("2098-12-31T00:00:00Z"), merchantOnly: true });

    const o = await orderRow("503-2000000-0000001");
    expect(o).toMatchObject({ status: "open", source: "sp_api", total_amount: 349800, ship_by: "2099-01-05", amazon_status: "UNSHIPPED" });
    const t = await openTask(`order:${o.id}`);
    expect(t).toMatchObject({ title: "自社出荷：503-2000000-0000001（ZB-G5070-R7 × 1）を出荷する", roleCode: "factory_manager" });
    expect(t?.dueAt?.toISOString()).toBe("2099-01-05T15:00:00.000Z");
  });

  it("次の回は前回の続きから（10分重ねる）。同じ注文は二重に登録しない", async () => {
    const api = fakeApi(() => [fakeOrder({ orderId: "503-2000000-0000001", shipBy: "2099-01-05T14:59:59Z" })]);
    const r = await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:05:00Z"));
    expect(r).toMatchObject({ ok: true, summary: { created: 0, unchanged: 1 } });
    expect(api.calls[0]).toEqual({ lastUpdatedAfter: new Date("2098-12-31T23:50:00Z"), merchantOnly: true });
    const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM core.orders WHERE external_order_no = '503-2000000-0000001'`);
    expect(n[0].n).toBe(1);
  });

  it("支払い待ち（PENDING）と FBA の注文は取り込まない", async () => {
    const api = fakeApi(() => [
      fakeOrder({ orderId: "503-2000000-0000002", status: "PENDING" }),
      fakeOrder({ orderId: "503-2000000-0000003", fulfilledBy: "AMAZON" }),
    ]);
    const r = await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:10:00Z"));
    expect(r).toMatchObject({ ok: true, summary: { skippedPending: 1, skippedNotMerchant: 1, created: 0 } });
    expect(await orderRow("503-2000000-0000002")).toBeUndefined();
  });

  it("支払いが済んで出荷できる状態になったら入る", async () => {
    const api = fakeApi(() => [fakeOrder({ orderId: "503-2000000-0000002", status: "UNSHIPPED" })]);
    expect(await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:15:00Z"))).toMatchObject({ summary: { created: 1 } });
  });

  it("出荷期限が変わったら、注文と ToDo の期限も変える", async () => {
    const api = fakeApi(() => [fakeOrder({ orderId: "503-2000000-0000001", shipBy: "2099-01-07T14:59:59Z", lastUpdatedTime: "2099-01-01T00:19:00Z" })]);
    expect(await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:20:00Z"))).toMatchObject({ summary: { updated: 1 } });
    const o = await orderRow("503-2000000-0000001");
    expect(o.ship_by).toBe("2099-01-07");
    expect((await openTask(`order:${o.id}`))?.dueAt?.toISOString()).toBe("2099-01-07T15:00:00.000Z");
  });
});

describe("取り込めない・食いちがう注文は ToDo で知らせる", () => {
  it("出品が登録されていない注文は取り込まずに知らせ、登録したら照合で入って知らせが閉じる", async () => {
    const order = fakeOrder({ orderId: "503-2000000-0000004", items: [{ sellerSku: "ZB-NEW-FBM", qty: 1, unitPrice: "429800.00" }] });
    const r1 = await syncAmazonOrders(fakeApi(() => [order]), "incremental", new Date("2099-01-01T00:25:00Z"));
    expect(r1).toMatchObject({ ok: true, summary: { unknownListing: 1 } });
    expect(await orderRow("503-2000000-0000004")).toBeUndefined();
    expect((await openTask("amazon-order:503-2000000-0000004"))?.title).toContain("ZB-NEW-FBM");
    // 2回目も知らせは1つのまま
    await syncAmazonOrders(fakeApi(() => [order]), "incremental", new Date("2099-01-01T00:30:00Z"));
    expect((await listOpenTasks(ALL)).filter((t) => t.sourceRef === "amazon-order:503-2000000-0000004")).toHaveLength(1);

    // 新しい機種を作って自社出荷用の出品を登録 → 照合で入る（ほかのテストが使う機種は変えない）
    const s = parseSkuInput({ code: "ZB-SYNC-TEST", name: "取り込みのテスト用の機種" });
    if (!s.ok) throw new Error();
    const created = await createSku(owner, s.value, null);
    if (!created.ok) throw new Error(created.message);
    await setAmazonListings(owner, created.id, { fulfillment: "fbm", fba: null, fbm: { sellerSku: "ZB-NEW-FBM", asin: "B0ZBDUMMY3" } });
    const api = fakeApi(() => [order]);
    const r2 = await syncAmazonOrders(api, "reconcile", new Date("2099-01-01T00:35:00Z"));
    expect(r2).toMatchObject({ ok: true, summary: { created: 1 } });
    expect(api.calls[0]).toEqual({ createdAfter: new Date("2098-12-25T00:35:00Z"), merchantOnly: true });
    expect(await openTask("amazon-order:503-2000000-0000004")).toBeUndefined();
    expect(await orderRow("503-2000000-0000004")).toMatchObject({ total_amount: 429800 });
  });

  it("Amazon で取り消された注文は、自動では取り消さずに知らせる", async () => {
    const o = await orderRow("503-2000000-0000002");
    const api = fakeApi(() => [fakeOrder({ orderId: "503-2000000-0000002", status: "CANCELLED" })]);
    expect(await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:40:00Z"))).toMatchObject({ summary: { cancelledOnAmazon: 1 } });
    expect(await orderRow("503-2000000-0000002")).toMatchObject({ status: "open", amazon_status: "CANCELLED" });
    expect(await openTask(`amazon-cancel:${o.id}`)).toBeDefined();
    await cancelFbmOrder(owner, o.id, "Amazon で取り消し");
  });

  it("Amazon では発送済みなのに、ここで出荷待ちなら知らせる", async () => {
    const o = await orderRow("503-2000000-0000001");
    const api = fakeApi(() => [fakeOrder({ orderId: "503-2000000-0000001", status: "SHIPPED" })]);
    expect(await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:45:00Z"))).toMatchObject({ summary: { shippedOnAmazon: 1 } });
    expect(await openTask(`amazon-shipped:${o.id}`)).toBeDefined();
  });

  it("読めない注文があったら、その回は失敗にして次の回で取り直す", async () => {
    const api = fakeApi(() => [fakeOrder({ orderId: "503-2000000-0000005", items: [{ sellerSku: "ZB-G5070-R7-FBM", qty: 1, unitPrice: "1.5" }] })]);
    const r = await syncAmazonOrders(api, "incremental", new Date("2099-01-01T00:50:00Z"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("503-2000000-0000005（単価が円の整数で読めない）") });
  });
});

describe("取り込みが止まったら", () => {
  it("失敗すると ToDo（代表）に出し、前回の続きの位置は進めない", async () => {
    const r = await syncAmazonOrders(failing, "incremental", new Date("2099-01-01T00:55:00Z"));
    expect(r).toMatchObject({ ok: false, error: "Amazon への問い合わせに失敗しました（503）。" });
    expect(await openTask("sync:amazon_orders")).toMatchObject({ roleCode: "ceo" });
    const api = fakeApi(() => []);
    await syncAmazonOrders(api, "incremental", new Date("2099-01-01T01:00:00Z"));
    // 最後に成功したのは 00:45 の回 → そこから10分重ねる
    expect(api.calls[0]).toEqual({ lastUpdatedAfter: new Date("2099-01-01T00:35:00Z"), merchantOnly: true });
  });

  it("成功すると、止まっていた知らせは自動で閉じる", async () => {
    expect(await openTask("sync:amazon_orders")).toBeUndefined();
    const [t] = await query<{ status: string }>(`SELECT status FROM core.tasks WHERE source_ref = 'sync:amazon_orders' ORDER BY id DESC LIMIT 1`);
    expect(t.status).toBe("done");
  });

  it("画面の警告：設定してあって30分以上成功していなければ「止まっている」", async () => {
    const h = await getSyncHealth(true);
    expect(h.lastSuccessAt).toBeInstanceOf(Date);
    expect(h.stale).toBe(false);
    expect((await getSyncHealth(false)).stale).toBe(false);
  });

  it("取り込みの記録には件数だけを残す（注文の中身は残さない）", async () => {
    const rows = await query<{ summary: unknown; error: string | null }>(`SELECT summary, error FROM core.integration_runs`);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("349800");
    expect(text).not.toContain("ZB-G5070-R7-FBM");
  });
});
