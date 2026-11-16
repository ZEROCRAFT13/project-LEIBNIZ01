// Amazon への出荷通知（承認して SP-API で送る）。本物の Amazon には つながず、まねた API で確かめる。
// ZB-G5070-R7 は自社出荷用の出品 ZB-G5070-R7-FBM がある（db/seeds/0005_dev_amazon.sql）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpApiError, type ShipConfirmApi, type ShipConfirmPackage } from "@/lib/amazon/sp-api";
import type { ApiOrder } from "@/lib/amazon/orders-map";
import { startUnit } from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import { createFbmOrder, getFbmOrder, linkUnit, markFbmShipped, setOrderTracking, updateFbmOrderInfo } from "@/lib/fbm";
import { getShipNoticePreview, sendShipNotice } from "@/lib/fbm-ship";
import { todayJst } from "@/lib/format";
import { fakeOrder } from "@/test/amazon-fixtures";

let owner: number;
let r7: number;
const SHIP_BY = todayJst(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

async function readyUnit(): Promise<string> {
  const sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;
  const m = await startUnit(sato, r7);
  await query(`UPDATE core.units SET status = 'ready', assembled_at = now(), inspected_at = now() WHERE mgmt_no = $1`, [m]);
  return m;
}

/** 発送まで済んだ自社出荷の注文を作る（箱ごとの送り状番号を決めて） */
async function shippedOrder(orderNo: string, trackings: string[], carrier: "yamato" | "seino" = "yamato"): Promise<number> {
  const r = (await createFbmOrder(owner, {
    orderNo,
    orderedAt: new Date(),
    shipBy: SHIP_BY,
    skuId: r7,
    qty: trackings.length,
    totalAmount: 349800 * trackings.length,
    note: null,
  })) as { ok: boolean; id: number };
  expect(r.ok).toBe(true);
  for (const t of trackings) {
    const m = await readyUnit();
    expect(await linkUnit(owner, r.id, m)).toMatchObject({ ok: true });
    expect(await setOrderTracking(owner, r.id, m, t)).toMatchObject({ ok: true });
  }
  await updateFbmOrderInfo(owner, r.id, { carrier, note: null });
  expect(await markFbmShipped(owner, r.id)).toMatchObject({ ok: true });
  return r.id;
}

/** まねた SP-API。送った箱を覚える */
function fakeApi(order: (orderNo: string) => ApiOrder | null, fail?: (n: number) => Error | null) {
  const sent: { orderNo: string; pkg: ShipConfirmPackage }[] = [];
  const api: ShipConfirmApi = {
    async getOrder(orderNo) {
      return order(orderNo);
    },
    async confirmShipment(orderNo, pkg) {
      const e = fail?.(sent.length);
      if (e) throw e;
      sent.push({ orderNo, pkg });
    },
  };
  return { api, sent };
}

const r7Order = (orderNo: string, qty: number, over: Partial<Parameters<typeof fakeOrder>[0]> = {}) =>
  fakeOrder({ orderId: orderNo, items: [{ sellerSku: "ZB-G5070-R7-FBM", qty, unitPrice: "349800.00" }], ...over });

const outbound = (orderId: number) =>
  query<{ status: string; error: string | null; payload: { carrierCode: string; boxes: { trackingNo: string }[] } }>(
    `SELECT status, error, payload FROM core.outbound_actions WHERE subject_type = 'order' AND subject_id = $1 ORDER BY id`,
    [orderId],
  );
const orderTask = (orderId: number) =>
  query<{ status: string; delay_reason: string | null }>(`SELECT status, delay_reason FROM core.tasks WHERE source_ref = $1 ORDER BY id DESC LIMIT 1`, [
    `order:${orderId}`,
  ]).then((r) => r[0]);

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  r7 = (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'"))[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("送る中身を見せる", () => {
  it("送り状番号ごとの箱と個体、運送会社の配送業者コード。キーがなければ送れない理由を出す", async () => {
    const id = await shippedOrder("503-0000007-0000001", ["1111-0000-0001", "1111-0000-0002"]);
    const p = await getShipNoticePreview(id, true);
    expect(p).toMatchObject({ orderNo: "503-0000007-0000001", carrier: "yamato", carrierCode: "Yamato Transport", blockers: [] });
    expect(p?.boxes.map((b) => b.trackingNo)).toEqual(["1111-0000-0001", "1111-0000-0002"]);
    expect(p?.boxes[0].skuCodes).toEqual(["ZB-G5070-R7"]);
    expect((await getShipNoticePreview(id, false))?.blockers).toEqual([expect.stringContaining("SP-API のキー")]);
  });
});

describe("承認して送る", () => {
  it("Amazon の注文の明細に合わせて箱ごとに送り、送れたら出荷通知済み（SP-API）にして ToDo を完了にする", async () => {
    const id = await shippedOrder("503-0000007-0000002", ["2222-0000-0001", "2222-0000-0002"]);
    const { api, sent } = fakeApi((no) => r7Order(no, 2));
    expect(await sendShipNotice(owner, id, null, api)).toMatchObject({ ok: true, message: expect.stringContaining("2箱") });

    const [shippedAt] = await query<{ shipped_at: Date }>("SELECT shipped_at FROM core.orders WHERE id = $1", [id]);
    expect(sent).toEqual([
      {
        orderNo: "503-0000007-0000002",
        pkg: {
          packageReferenceId: "1",
          carrierCode: "Yamato Transport",
          trackingNumber: "2222-0000-0001",
          shipDate: shippedAt.shipped_at.toISOString(),
          orderItems: [{ orderItemId: "ITEM0", quantity: 1 }],
        },
      },
      expect.objectContaining({ pkg: expect.objectContaining({ packageReferenceId: "2", trackingNumber: "2222-0000-0002" }) }),
    ]);
    const [o] = await query<{ ship_notified_via: string; ship_notified_by: number }>(
      "SELECT ship_notified_via, ship_notified_by FROM core.orders WHERE id = $1",
      [id],
    );
    expect(o).toEqual({ ship_notified_via: "sp_api", ship_notified_by: owner });
    expect((await outbound(id)).map((a) => a.status)).toEqual(["sent"]);
    expect((await outbound(id))[0].payload).toMatchObject({ carrierCode: "Yamato Transport", boxes: [{ trackingNo: "2222-0000-0001" }, {}] });
    expect(await orderTask(id)).toMatchObject({ status: "done" });
    expect(await getFbmOrder(id)).toMatchObject({ notifiedBy: "代表" });

    // 済んだものは、もう送らない
    expect(await sendShipNotice(owner, id, null, api)).toMatchObject({ ok: false, message: expect.stringContaining("もう済んでいます") });
    expect(sent).toHaveLength(2);
  });

  it("Amazon が失敗したら理由を残して、出荷通知はまだのまま。送り直すと同じ箱の番号で送る", async () => {
    const id = await shippedOrder("503-0000007-0000003", ["3333-0000-0001", "3333-0000-0002"]);
    const broken = fakeApi(
      (no) => r7Order(no, 2),
      (n) => (n === 1 ? new SpApiError("Amazon への送信に失敗しました（400 InvalidInput）。", 400, "InvalidInput") : null),
    );
    const r = await sendShipNotice(owner, id, null, broken.api);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("400 InvalidInput") });
    expect(r.message).toContain("1箱目までは送れています");
    expect(await outbound(id)).toMatchObject([{ status: "failed", error: expect.stringContaining("InvalidInput") }]);
    expect(await getFbmOrder(id)).toMatchObject({ notifiedAt: null });
    expect(await orderTask(id)).toMatchObject({ status: expect.not.stringMatching("done") });

    const ok = fakeApi((no) => r7Order(no, 2));
    expect(await sendShipNotice(owner, id, null, ok.api)).toMatchObject({ ok: true });
    expect(ok.sent.map((s) => s.pkg.packageReferenceId)).toEqual(["1", "2"]);
    expect((await outbound(id)).map((a) => a.status)).toEqual(["failed", "sent"]);
  });

  it("Amazon の注文と数が合わない・取り消し・FBA・見つからないときは、何も送らない", async () => {
    const id = await shippedOrder("503-0000007-0000004", ["4444-0000-0001", "4444-0000-0002"]);
    for (const [order, words] of [
      [(no: string) => r7Order(no, 1), "合わない"],
      [(no: string) => r7Order(no, 2, { status: "CANCELLED" }), "取り消されています"],
      [(no: string) => r7Order(no, 2, { fulfilledBy: "AMAZON" }), "自社出荷になっていません"],
      [() => null, "見つかりません"],
      [(no: string) => fakeOrder({ orderId: no, items: [{ sellerSku: "UNKNOWN-SKU", qty: 2, unitPrice: "1.00" }] }), "UNKNOWN-SKU"],
    ] as const) {
      const f = fakeApi(order);
      expect(await sendShipNotice(owner, id, null, f.api)).toMatchObject({ ok: false, message: expect.stringContaining(words) });
      expect(f.sent).toHaveLength(0);
    }
    expect((await outbound(id)).every((a) => a.status === "failed")).toBe(true);
  });

  it("この画面から送れない運送会社（西濃など）・キーがないときは、承認の記録も作らない", async () => {
    const id = await shippedOrder("503-0000007-0000005", ["5555-0000-0001"], "seino");
    const f = fakeApi((no) => r7Order(no, 1));
    expect(await sendShipNotice(owner, id, null, f.api)).toMatchObject({ ok: false, message: expect.stringContaining("セラーセントラル") });
    expect(await sendShipNotice(owner, id, null, null)).toMatchObject({ ok: false, message: expect.stringContaining("SP-API のキー") });
    expect(await outbound(id)).toEqual([]);
    expect(f.sent).toHaveLength(0);
  });

  it("出荷期限を過ぎていたら、遅れた理由がないと送らない（送ってから ToDo を完了できないことがないように）", async () => {
    const id = await shippedOrder("503-0000007-0000006", ["6666-0000-0001"]);
    await query(`UPDATE core.tasks SET due_at = now() - interval '1 day' WHERE source_ref = $1 AND status <> 'done'`, [`order:${id}`]);
    const f = fakeApi((no) => r7Order(no, 1));
    expect(await sendShipNotice(owner, id, null, f.api)).toMatchObject({ ok: false, message: expect.stringContaining("遅れた理由") });
    expect(f.sent).toHaveLength(0);
    expect(await outbound(id)).toEqual([]);
    expect(await sendShipNotice(owner, id, "部品の入荷待ち", f.api)).toMatchObject({ ok: true });
    expect(await orderTask(id)).toMatchObject({ status: "done", delay_reason: "部品の入荷待ち" });
  });
});
