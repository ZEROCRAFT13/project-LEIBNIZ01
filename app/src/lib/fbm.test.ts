// 自社出荷（ダミーデータの DB に対して）。ZB-G5070-R7 は「両方」で、自社出荷用の出品がある（db/seeds/0005_dev_amazon.sql）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUnit } from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import { addUnitToShipment, createFbaShipment } from "@/lib/fba";
import {
  cancelFbmOrder,
  createFbmOrder,
  getFbmOrder,
  linkUnit,
  listFbmOrders,
  listFbmSkus,
  markFbmShipped,
  markShipNotified,
  setOrderTracking,
  unlinkUnit,
  updateFbmOrderInfo,
} from "@/lib/fbm";

let owner: number;
let r7: number;
let r5: number;
const u: string[] = []; // R7 の出荷待ち
let inFba: string; // R7 だが FBA の納品に入れたもの
let r5Unit: string;
let order: number;

async function readyUnit(sku: number): Promise<string> {
  const sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;
  const m = await startUnit(sato, sku);
  await query(`UPDATE core.units SET status = 'ready', assembled_at = now(), inspected_at = now() WHERE mgmt_no = $1`, [m]);
  return m;
}

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  r7 = (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'"))[0].id;
  r5 = (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5060-R5'"))[0].id;
  u.push(await readyUnit(r7), await readyUnit(r7), await readyUnit(r7));
  inFba = await readyUnit(r7);
  r5Unit = await readyUnit(r5);
  const s = await createFbaShipment(owner);
  await addUnitToShipment(owner, s, inFba);
});

afterAll(async () => {
  await getPool().end();
});

const input = (orderNo: string, qty = 2) => ({
  orderNo,
  orderedAt: new Date(),
  shipBy: "2026-11-03",
  skuId: r7,
  qty,
  totalAmount: 349800 * qty,
  note: null,
});

describe("注文の登録", () => {
  it("自社出荷で売っている機種と、今出せる台数（FBA の納品に入れたものは数えない）", async () => {
    const skus = await listFbmSkus();
    expect(skus.map((s) => s.code)).toContain("ZB-G5070-R7");
    expect(skus.map((s) => s.code)).not.toContain("ZB-G5060-R5"); // FBA だけ
    const r7row = skus.find((s) => s.code === "ZB-G5070-R7")!;
    expect(r7row.sellerSku).toBe("ZB-G5070-R7-FBM");
    expect(r7row.available).toBeGreaterThanOrEqual(3);
  });

  it("注文番号で登録する。1台あたりの金額は合計を数で割る", async () => {
    const r = await createFbmOrder(owner, input("503-0000001-0000001"));
    expect(r).toMatchObject({ ok: true });
    order = (r as { id: number }).id;
    const d = await getFbmOrder(order);
    expect(d).toMatchObject({ status: "open", qty: 2, linked: 0, totalAmount: 699600, shipBy: "2026-11-03" });
    expect(d?.lines).toEqual([{ skuId: r7, skuCode: "ZB-G5070-R7", skuName: expect.any(String), qty: 2, unitPrice: 349800 }]);
    expect(d?.candidates.map((c) => c.mgmtNo)).toEqual(expect.arrayContaining(u));
    expect(d?.candidates.map((c) => c.mgmtNo)).not.toContain(inFba);
  });

  it("同じ注文番号・自社出荷で売っていない機種は断る", async () => {
    expect(await createFbmOrder(owner, input("503-0000001-0000001"))).toMatchObject({
      ok: false,
      message: "その注文番号は、もう登録されています。",
    });
    expect(await createFbmOrder(owner, { ...input("503-0000001-0000009"), skuId: r5 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("自社出荷で売っていません"),
    });
  });
});

describe("個体を結びつけて発送する", () => {
  it("管理番号（QR の URL でも）を読んで結びつける。合わない個体は断る", async () => {
    expect(await linkUnit(owner, order, u[0])).toMatchObject({ ok: true });
    expect(await linkUnit(owner, order, `https://zero-bit.jp/r/${u[1]}`)).toMatchObject({ ok: true });
    expect(await linkUnit(owner, order, u[2])).toMatchObject({ ok: false, message: expect.stringContaining("注文台数分") });
    expect(await linkUnit(owner, order, inFba)).toMatchObject({ ok: false });
    expect(await linkUnit(owner, order, r5Unit)).toMatchObject({ ok: false, message: expect.stringContaining("SKU") });
    expect(await linkUnit(owner, order, "9MP4C0501")).toMatchObject({ ok: false });
  });

  it("別の注文に結びついた個体は使えない", async () => {
    const other = (await createFbmOrder(owner, input("503-0000001-0000002", 1))) as { id: number };
    expect(await linkUnit(owner, other.id, u[0])).toMatchObject({ ok: false, message: "その個体は、もう別の注文に結びついています。" });
    expect(await cancelFbmOrder(owner, other.id, "テスト")).toMatchObject({ ok: true });
  });

  it("発送前なら外して、別の個体に替えられる", async () => {
    expect(await unlinkUnit(owner, order, u[1])).toMatchObject({ ok: true });
    expect(await linkUnit(owner, order, u[2])).toMatchObject({ ok: true });
    expect((await getFbmOrder(order))?.units.map((x) => x.mgmtNo)).toEqual([u[0], u[2]]);
  });

  it("送り状番号と運送会社がそろわないと発送できない", async () => {
    expect(await markFbmShipped(owner, order)).toMatchObject({ ok: false });
    await setOrderTracking(owner, order, u[0], "１２３４－５６７８－９０１２");
    expect(await markFbmShipped(owner, order)).toMatchObject({ ok: false, message: expect.stringContaining("送り状番号") });
    await setOrderTracking(owner, order, u[2], "1234-5678-9013");
    expect(await markFbmShipped(owner, order)).toMatchObject({ ok: false, message: "運送会社を選んでください" });
    await updateFbmOrderInfo(owner, order, { carrier: "yamato", note: null });
  });

  it("発送すると、個体は「出荷済み」（お客様へ）になる。出荷通知はまだ", async () => {
    expect(await markShipNotified(owner, order)).toMatchObject({ ok: false });
    expect(await markFbmShipped(owner, order)).toMatchObject({ ok: true });
    const d = await getFbmOrder(order);
    expect(d).toMatchObject({ status: "shipped", notifiedAt: null });
    expect(d?.units.every((x) => x.status === "shipped")).toBe(true);
    expect(d?.units[0].trackingNo).toBe("1234-5678-9012");
    const [unit] = await query<{ ship_destination: string }>("SELECT ship_destination FROM core.units WHERE mgmt_no = $1", [u[0]]);
    expect(unit.ship_destination).toBe("customer");
    // 出荷通知がまだの注文は、一覧の上のほうに出る
    expect((await listFbmOrders()).find((o) => o.id === order)).toMatchObject({ status: "shipped", notifiedAt: null });
  });

  it("発送したら外せない・取り消せない。出荷通知は1回だけ記録する", async () => {
    expect(await unlinkUnit(owner, order, u[0])).toMatchObject({ ok: false });
    expect(await cancelFbmOrder(owner, order, "x")).toMatchObject({ ok: false });
    expect(await markShipNotified(owner, order)).toMatchObject({ ok: true });
    expect(await markShipNotified(owner, order)).toMatchObject({ ok: false });
    expect(await getFbmOrder(order)).toMatchObject({ notifiedBy: "代表" });
  });

  it("取り消した注文の個体は、出荷待ちに戻って使える", async () => {
    const o = (await createFbmOrder(owner, input("503-0000001-0000003", 1))) as { id: number };
    await linkUnit(owner, o.id, u[1]);
    expect(await cancelFbmOrder(owner, o.id, "")).toMatchObject({ ok: false });
    expect(await cancelFbmOrder(owner, o.id, "お客様のキャンセル")).toMatchObject({ ok: true });
    expect(await getFbmOrder(o.id)).toMatchObject({ status: "cancelled", cancelReason: "お客様のキャンセル", linked: 0 });
    const o2 = (await createFbmOrder(owner, input("503-0000001-0000004", 1))) as { id: number };
    expect(await linkUnit(owner, o2.id, u[1])).toMatchObject({ ok: true });
  });
});
