// FBA 納品（ダミーデータの DB に対して）。ZB-G5060-R5 は FBA、ZB-G5070-R7 は両方（db/seeds/0005_dev_amazon.sql）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUnit } from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import {
  addUnitToShipment,
  cancelShipment,
  createFbaShipment,
  getFbaShipment,
  listFbaShipments,
  listReadyForFba,
  markShipped,
  recordReceipts,
  removeUnitFromShipment,
  setUnitTracking,
  updateShipmentInfo,
} from "@/lib/fba";
import { parseSkuInput } from "@/lib/sku-calc";
import { createSku } from "@/lib/skus";

let owner: number;
let r5: number; // ZB-G5060-R5（FBA）
let r7: number; // ZB-G5070-R7（両方）
const a: string[] = []; // R5 の出荷待ち
const b: string[] = []; // R7 の出荷待ち
let notFba: string; // Amazon で売らない機種の出荷待ち
let notReady: string; // 検品中
let shipment: number;

const skuId = async (code: string) => (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = $1", [code]))[0].id;

/** 組立と検品が終わったことにする（それぞれのテストで確かめているので、ここでは状態だけ） */
async function readyUnit(sku: number, status = "ready"): Promise<string> {
  const sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;
  const m = await startUnit(sato, sku);
  await query(`UPDATE core.units SET status = $2, assembled_at = now() WHERE mgmt_no = $1`, [m, status]);
  return m;
}

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  r5 = await skuId("ZB-G5060-R5");
  r7 = await skuId("ZB-G5070-R7");
  a.push(await readyUnit(r5), await readyUnit(r5));
  b.push(await readyUnit(r7));
  notReady = await readyUnit(r5, "inspecting");
  const s = parseSkuInput({ code: "ZB-DIRECT-1", name: "直販だけの機種" });
  if (!s.ok) throw new Error();
  const created = await createSku(owner, s.value, null);
  if (!created.ok) throw new Error(created.message);
  notFba = await readyUnit(created.id);
});

afterAll(async () => {
  await getPool().end();
});

describe("納品に入れる", () => {
  it("FBA に送れるのは、出荷待ちで FBA（または両方）の機種の個体だけ", async () => {
    const ready = (await listReadyForFba()).map((u) => u.mgmtNo);
    expect(ready).toEqual(expect.arrayContaining([...a, ...b]));
    expect(ready).not.toContain(notFba);
    expect(ready).not.toContain(notReady);
  });

  it("下書きを作り、管理番号（QR の URL でも）を読んで入れる", async () => {
    shipment = await createFbaShipment(owner);
    expect(await addUnitToShipment(owner, shipment, a[0])).toMatchObject({ ok: true });
    expect(await addUnitToShipment(owner, shipment, `https://zero-bit.jp/r/${a[1]}`)).toMatchObject({ ok: true });
    expect(await addUnitToShipment(owner, shipment, b[0].toLowerCase())).toMatchObject({ ok: true });
    const d = await getFbaShipment(shipment);
    expect(d).toMatchObject({ status: "draft", unitCount: 3, notReady: 0 });
    expect(d?.bySku.map((r) => [r.skuCode, r.sent])).toEqual([
      ["ZB-G5060-R5", 2],
      ["ZB-G5070-R7", 1],
    ]);
    expect((await listReadyForFba()).map((u) => u.mgmtNo)).not.toContain(a[0]);
  });

  it("入れられない個体は、理由を言って断る", async () => {
    expect(await addUnitToShipment(owner, shipment, a[0])).toMatchObject({ ok: false, message: expect.stringContaining("もう") });
    expect(await addUnitToShipment(owner, shipment, notReady)).toMatchObject({
      ok: false,
      message: expect.stringContaining("出荷待ちではありません"),
    });
    expect(await addUnitToShipment(owner, shipment, notFba)).toMatchObject({
      ok: false,
      message: expect.stringContaining("FBA で売る設定ではありません"),
    });
    expect(await addUnitToShipment(owner, shipment, "ZB-9999-9999")).toMatchObject({ ok: false, message: "ZB-9999-9999 という個体はありません。" });
    expect(await addUnitToShipment(owner, shipment, "9MP4C0501")).toMatchObject({ ok: false });
    const other = await createFbaShipment(owner);
    expect(await addUnitToShipment(owner, other, a[0])).toMatchObject({ ok: false, message: expect.stringContaining("別の納品に入っています") });
    await cancelShipment(owner, other);
  });

  it("下書きなら外せる", async () => {
    expect(await removeUnitFromShipment(owner, shipment, b[0])).toMatchObject({ ok: true });
    expect(await removeUnitFromShipment(owner, shipment, b[0])).toMatchObject({ ok: false });
    await addUnitToShipment(owner, shipment, b[0]);
  });
});

describe("発送", () => {
  it("Amazon の番号がないと発送できない", async () => {
    expect(await markShipped(owner, shipment)).toMatchObject({ ok: false });
  });

  it("番号・倉庫・運送会社と、箱ごとの送り状番号を入れて発送する。個体は「FBA へ輸送中」になる", async () => {
    expect(
      await updateShipmentInfo(owner, shipment, {
        amazonShipmentId: "FBA15TESTA01",
        destinationFc: "NRT5",
        carrier: "yamato",
        note: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await setUnitTracking(owner, shipment, a[0], "４５６７－８９０１－２３４５")).toMatchObject({ ok: true });
    expect(await setUnitTracking(owner, shipment, a[1], "abc")).toMatchObject({ ok: false });
    expect(await markShipped(owner, shipment)).toMatchObject({ ok: true, message: expect.stringContaining("3台") });

    const d = await getFbaShipment(shipment);
    expect(d).toMatchObject({ status: "shipped", amazonShipmentId: "FBA15TESTA01", destinationFc: "NRT5" });
    expect(d?.units.find((u) => u.mgmtNo === a[0])).toMatchObject({ status: "inbound_to_fba", trackingNo: "4567-8901-2345" });
    expect(d?.units.every((u) => u.status === "inbound_to_fba")).toBe(true);
  });

  it("発送したら、個体の出し入れ・Amazon の番号の変更・取り消しはできない", async () => {
    expect(await removeUnitFromShipment(owner, shipment, a[0])).toMatchObject({ ok: false });
    expect(await cancelShipment(owner, shipment)).toMatchObject({ ok: false });
    await updateShipmentInfo(owner, shipment, { amazonShipmentId: "FBA15OTHER1", destinationFc: "NRT5", carrier: "yamato", note: "メモ" });
    expect(await getFbaShipment(shipment)).toMatchObject({ amazonShipmentId: "FBA15TESTA01", note: "メモ" });
  });

  it("同じ Amazon の番号は、別の納品に使えない", async () => {
    const other = await createFbaShipment(owner);
    const r = await updateShipmentInfo(owner, other, { amazonShipmentId: "FBA15TESTA01", destinationFc: null, carrier: null, note: null });
    expect(r).toMatchObject({ ok: false, message: "その Amazon の出荷の番号は、もう別の納品に入っています。" });
    await cancelShipment(owner, other);
  });
});

describe("受領", () => {
  it("一部だけ受領されたら「受領中」。個体は輸送中のまま", async () => {
    const r = await recordReceipts(owner, shipment, [{ skuId: r5, receivedQty: 2 }]);
    expect(r).toMatchObject({ ok: true, closed: false, message: "受領数を保存しました（2 / 3台）。" });
    const d = await getFbaShipment(shipment);
    expect(d).toMatchObject({ status: "receiving", allReceived: false, receivedCount: 2 });
    expect(d?.units.every((u) => u.status === "inbound_to_fba")).toBe(true);
  });

  it("送った台数より多い受領数は断る", async () => {
    expect(await recordReceipts(owner, shipment, [{ skuId: r7, receivedQty: 2 }])).toMatchObject({ ok: false });
  });

  it("全部受領されたら完了になり、個体は「FBA 在庫」になる", async () => {
    const r = await recordReceipts(owner, shipment, [{ skuId: r7, receivedQty: 1 }]);
    expect(r).toMatchObject({ ok: true, closed: true });
    const d = await getFbaShipment(shipment);
    expect(d).toMatchObject({ status: "closed", allReceived: true });
    expect(d?.closedAt).toBeInstanceOf(Date);
    expect(d?.units.every((u) => u.status === "at_fba")).toBe(true);
    expect(await recordReceipts(owner, shipment, [{ skuId: r7, receivedQty: 0 }])).toMatchObject({ ok: false });
  });

  it("一覧に出る（取り消した下書きも直近なら出る）", async () => {
    const list = await listFbaShipments();
    expect(list.find((s) => s.id === shipment)).toMatchObject({ status: "closed", unitCount: 3, receivedCount: 3 });
    expect(list.some((s) => s.status === "cancelled")).toBe(true);
  });
});
