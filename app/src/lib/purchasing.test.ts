// 仕入れの登録と入荷のテスト。db/seeds のダミーデータが入ったDBに対して動かす（在庫と原価の計算: ルール10）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, query } from "@/lib/db";
import { parsePurchaseInput } from "@/lib/purchase-calc";
import {
  PurchaseError,
  addShipment,
  cancelReceipt,
  createPurchase,
  findArrival,
  getPurchase,
  listPartModels,
  listPurchases,
  listSuppliers,
  receiveBulk,
  receiveSerial,
  removeShipment,
} from "@/lib/purchasing";

let owner: number;
let gpu: number; // RTX5070-A12G（シリアルあり・元箱を保管）
let caseModel: number; // MT-ATX（シリアルなし）
let ssd: number; // NV4-1TB（シリアルあり・元箱なし）
let dospara: number;
let purchaseId: number;

const pm = async (modelNo: string) =>
  (await query<{ id: number }>("SELECT id FROM core.part_models WHERE model_no = $1", [modelNo]))[0].id;

async function lines() {
  const p = await getPurchase(purchaseId);
  if (!p) throw new Error("purchase");
  return { p, gpuLine: p.lines[0], caseLine: p.lines[1], ssdLine: p.lines[2], shipping: p.lines[3] };
}

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  gpu = await pm("RTX5070-A12G");
  caseModel = await pm("MT-ATX");
  ssd = await pm("NV4-1TB");
  dospara = (await listSuppliers()).find((s) => s.name === "ドスパラ")!.id;
});

afterAll(async () => {
  await getPool().end();
});

describe("仕入れを登録する", () => {
  it("仕入先と部品の選択肢が出る", async () => {
    expect((await listSuppliers()).map((s) => s.name)).toContain("ドスパラ");
    const models = await listPartModels();
    expect(models.find((m) => m.id === gpu)).toMatchObject({ category: "gpu", serialRequired: true, keepBox: true });
    expect(models[0].category).toBe("cpu");
  });

  it("明細と合計・消費税が保存され、明細の消費税は単価から計算される", async () => {
    const parsed = parsePurchaseInput(
      {
        supplierId: String(dospara),
        orderNo: "DS-TEST-1",
        orderedOn: "2026-10-30",
        paymentMethod: "card",
        tax: "",
        lines: [
          { partModelId: String(gpu), description: "", qty: "2", unitPrice: "98780" },
          { partModelId: String(caseModel), description: "", qty: "3", unitPrice: "8980" },
          { partModelId: String(ssd), description: "", qty: "1", unitPrice: "12980" },
          { partModelId: null, description: "送料", qty: "1", unitPrice: "880" },
        ],
      },
      "2026-11-01",
    );
    if (!parsed.ok) throw new Error(parsed.errors.join());
    purchaseId = await createPurchase(owner, parsed.value);

    const { p, gpuLine, caseLine, shipping } = await lines();
    expect(p).toMatchObject({ supplier: "ドスパラ", orderNo: "DS-TEST-1", total: 238360, tax: 21669, status: "ordered" });
    expect(gpuLine).toMatchObject({ description: "GeForce RTX 5070 12GB", qty: 2, unitPrice: 98780, unitTax: 8980 });
    expect(caseLine).toMatchObject({ qty: 3, unitPrice: 8980, unitTax: 816 });
    expect(shipping).toMatchObject({ description: "送料", model: null, unitTax: 80 });
    expect((await listPurchases()).find((r) => r.id === purchaseId)).toMatchObject({
      status: "ordered",
      received: 0,
      expected: 6,
    });
  });

  it("同じ仕入先・同じ注文番号は二重に登録しない（登録済みの仕入れを教える）", async () => {
    const parsed = parsePurchaseInput(
      {
        supplierId: String(dospara),
        orderNo: "DS-TEST-1",
        orderedOn: "2026-10-30",
        paymentMethod: "card",
        tax: "",
        lines: [{ partModelId: String(gpu), description: "", qty: "1", unitPrice: "1" }],
      },
      "2026-11-01",
    );
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const err = await createPurchase(owner, parsed.value).catch((e) => e);
    expect(err).toBeInstanceOf(PurchaseError);
    expect(err.existingId).toBe(purchaseId);
  });

  it("使えない部品を指定したら、仕入れごと登録しない", async () => {
    const before = (await listPurchases()).length;
    await expect(
      createPurchase(owner, {
        supplierId: dospara,
        orderNo: "DS-TEST-2",
        orderedOn: "2026-10-30",
        paymentMethod: "card",
        lines: [{ partModelId: 999999, description: "", qty: 1, unitPrice: 100 }],
        total: 100,
        tax: 9,
      }),
    ).rejects.toThrow("その部品は選べません");
    expect((await listPurchases()).length).toBe(before);
  });
});

describe("入荷する", () => {
  it("元箱を保管する部品は、棚番がないと入荷できない", async () => {
    const { gpuLine } = await lines();
    expect(await receiveSerial(owner, gpuLine.id, "GPU-NEW-001", "")).toMatchObject({ ok: false });
  });

  it("シリアルのない部品（ケース）は、シリアルを読む入荷を断る", async () => {
    const { caseLine } = await lines();
    expect(await receiveSerial(owner, caseLine.id, "X", "")).toMatchObject({ ok: false });
  });

  it("シリアルを読むと1個ずつ入荷し、原価は単価から税抜・税に分けて入る。状態は一部入荷になる", async () => {
    const { gpuLine } = await lines();
    const r = await receiveSerial(owner, gpuLine.id, "ｇｐｕ－ｎｅｗ－００１", "ｂ－０７");
    expect(r).toEqual({ ok: true, message: "GeForce RTX 5070 12GB（GPU-NEW-001）を入荷しました。元箱は B-07 へ。" });
    const [item] = await query<{ cost_excl_tax: number; cost_tax: number; box_kept: boolean; box_location: string; status: string }>(
      "SELECT cost_excl_tax, cost_tax, box_kept, box_location, status FROM core.part_items WHERE serial_no = 'GPU-NEW-001'",
    );
    expect(item).toEqual({ cost_excl_tax: 89800, cost_tax: 8980, box_kept: true, box_location: "B-07", status: "in_stock" });
    expect((await lines()).p.status).toBe("partially_received");
  });

  it("同じシリアルを2回読んだら断る", async () => {
    const { gpuLine } = await lines();
    const r = await receiveSerial(owner, gpuLine.id, "GPU-NEW-001", "B-07");
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("もう入荷済み") });
  });

  it("明細の数を超えては入荷できない", async () => {
    const { gpuLine } = await lines();
    expect(await receiveSerial(owner, gpuLine.id, "GPU-NEW-002", "B-08")).toMatchObject({ ok: true });
    const r = await receiveSerial(owner, gpuLine.id, "GPU-NEW-003", "B-08");
    expect(r).toEqual({ ok: false, message: "仕入れの数（2個）より多くは入荷できません" });
  });

  it("シリアルのない部品は数でまとめて入荷する。多すぎるとまとめて断る", async () => {
    const { caseLine } = await lines();
    expect(await receiveBulk(owner, caseLine.id, 4, "")).toMatchObject({ ok: false });
    expect((await lines()).caseLine.items).toHaveLength(0);
    expect(await receiveBulk(owner, caseLine.id, 3, "")).toEqual({ ok: true, message: "ミドルタワー ATX を 3個 入荷しました。" });
    const items = (await lines()).caseLine.items;
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.serialNo === null && i.boxLocation === null)).toBe(true);
  });

  it("シリアルのある部品は、まとめて入荷できない", async () => {
    const { ssdLine } = await lines();
    expect(await receiveBulk(owner, ssdLine.id, 1, "")).toMatchObject({ ok: false });
  });

  it("送料の明細には入荷できない", async () => {
    const { shipping } = await lines();
    expect(await receiveSerial(owner, shipping.id, "X", "")).toMatchObject({ ok: false });
    expect(await receiveBulk(owner, shipping.id, 1, "")).toMatchObject({ ok: false });
  });

  it("全部そろうと入荷済みになり、在庫に入る", async () => {
    const { ssdLine } = await lines();
    expect(await receiveSerial(owner, ssdLine.id, "S6Z-NEW-1", "")).toMatchObject({ ok: true });
    expect((await lines()).p.status).toBe("received");
    expect((await listPurchases()).find((r) => r.id === purchaseId)).toMatchObject({ received: 6, expected: 6 });
    const [stock] = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.part_items WHERE part_model_id = $1 AND status = 'in_stock' AND serial_no LIKE 'GPU-NEW-%'",
      [gpu],
    );
    expect(stock.n).toBe(2);
  });

  it("読み間違えた入荷は取り消せて、状態が一部入荷に戻る", async () => {
    const { ssdLine } = await lines();
    const r = await cancelReceipt(owner, ssdLine.items[0].id);
    expect(r).toEqual({ ok: true, message: "入荷を取り消しました（S6Z-NEW-1）。" });
    expect((await lines()).p.status).toBe("partially_received");
  });

  it("組立に使った部品の入荷は取り消せない", async () => {
    const [used] = await query<{ id: number }>(
      "SELECT part_item_id AS id FROM core.unit_parts WHERE removed_at IS NULL LIMIT 1",
    );
    expect(await cancelReceipt(owner, used.id)).toMatchObject({ ok: false });
  });

  it("JANコードを読んだら、シリアルを読むように言う（JANが登録されている部品）", async () => {
    const psu = await pm("GD850");
    const parsed = parsePurchaseInput(
      {
        supplierId: String(dospara),
        orderNo: "DS-TEST-JAN",
        orderedOn: "2026-10-30",
        paymentMethod: "card",
        tax: "",
        lines: [{ partModelId: String(psu), description: "", qty: "1", unitPrice: "16980" }],
      },
      "2026-11-01",
    );
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const id = await createPurchase(owner, parsed.value);
    const line = (await getPurchase(id))!.lines[0];
    const r = await receiveSerial(owner, line.id, "2000000000022", "C-01");
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("JANコード") });
  });
});

describe("発送（輸送中）と、届いた荷物から仕入れを探す", () => {
  let shipId: number;

  beforeAll(async () => {
    const parsed = parsePurchaseInput(
      {
        supplierId: String(dospara),
        orderNo: "EC0000000001",
        orderedOn: "2026-10-31",
        paymentMethod: "card",
        tax: "",
        lines: [{ partModelId: String(ssd), description: "", qty: "2", unitPrice: "12980" }],
      },
      "2026-11-01",
    );
    if (!parsed.ok) throw new Error(parsed.errors.join());
    shipId = await createPurchase(owner, parsed.value);
  });

  it("発送を登録すると「輸送中」になる。追跡番号はハイフンなしでそろえる", async () => {
    expect(await addShipment(owner, shipId, "yamato", "4444-5555-6666", "2026-11-02")).toEqual({
      ok: true,
      message: "追跡番号 444455556666 を登録しました。",
    });
    const p = (await getPurchase(shipId))!;
    expect(p.status).toBe("in_transit");
    expect(p.shipments).toEqual([
      { id: expect.any(Number), carrier: "yamato", trackingNo: "444455556666", expectedOn: "2026-11-02", deliveredAt: null },
    ]);
  });

  it("2個口目も登録できる。同じ追跡番号は二重に登録しない。おかしな入力は断る", async () => {
    expect(await addShipment(owner, shipId, "yamato", "444455556667", null)).toMatchObject({ ok: true });
    expect(await addShipment(owner, shipId, "yamato", "444455556666", null)).toMatchObject({ ok: false });
    expect(await addShipment(owner, shipId, "pigeon", "444455556668", null)).toMatchObject({ ok: false });
    expect(await addShipment(owner, shipId, "yamato", "12", null)).toMatchObject({ ok: false });
    expect(await addShipment(owner, shipId, "yamato", "444455556669", "明日")).toMatchObject({ ok: false });
    expect((await getPurchase(shipId))!.shipments).toHaveLength(2);
  });

  it("送り状のバーコードを読むと、その仕入れが見つかり、荷物は「届いた」になる", async () => {
    const r = await findArrival(owner, "a444455556666a");
    expect(r).toEqual({ kind: "shipment", purchaseId: shipId, shipmentId: expect.any(Number) });
    const s = (await getPurchase(shipId))!.shipments.find((x) => x.trackingNo === "444455556666");
    expect(s?.deliveredAt).toBeInstanceOf(Date);
    // 2個口目はまだ輸送中
    expect((await getPurchase(shipId))!.shipments.find((x) => x.trackingNo === "444455556667")?.deliveredAt).toBeNull();
  });

  it("仕入先の注文番号でも探せる。見つからなければ none", async () => {
    expect(await findArrival(owner, "ec0000000001")).toEqual({ kind: "order", purchaseId: shipId });
    expect(await findArrival(owner, "999999999999")).toEqual({ kind: "none" });
    expect(await findArrival(owner, "  ")).toEqual({ kind: "none" });
  });

  it("入荷すると「一部入荷」→「入荷済み」になり、発送を消しても入荷の状態は変わらない", async () => {
    const line = (await getPurchase(shipId))!.lines[0];
    await receiveSerial(owner, line.id, "S6Z-SHIP-1", "");
    expect((await getPurchase(shipId))!.status).toBe("partially_received");
    await receiveSerial(owner, line.id, "S6Z-SHIP-2", "");
    expect((await getPurchase(shipId))!.status).toBe("received");
    const s = (await getPurchase(shipId))!.shipments[1];
    expect(await removeShipment(owner, s.id)).toMatchObject({ ok: true });
    expect((await getPurchase(shipId))!.status).toBe("received");
  });
});
