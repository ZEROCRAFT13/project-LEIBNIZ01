// 部品の型番・仕入先の追加と変更（ダミーデータの DB に対して）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, query } from "@/lib/db";
import { parsePartModelInput, parseSupplierInput, type PartModelInput, type SupplierInput } from "@/lib/master-calc";
import { listPartModels, listSuppliers } from "@/lib/purchasing";
import {
  createPartModel,
  createSupplier,
  getPartModel,
  getSupplier,
  listAllPartModels,
  listAllSuppliers,
  updatePartModel,
  updateSupplier,
} from "./masters";

let owner: number;

function part(raw: Record<string, unknown>): PartModelInput {
  const r = parsePartModelInput(raw);
  if (!r.ok) throw new Error(r.errors.join());
  return r.value;
}

function supplier(raw: Record<string, unknown>): SupplierInput {
  const r = parseSupplierInput(raw);
  if (!r.ok) throw new Error(r.errors.join());
  return r.value;
}

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("部品の型番", () => {
  let id: number;
  const base = {
    category: "memory",
    maker: "メーカーX",
    modelNo: "DDR4-3200-8X2",
    name: "DDR4-3200 16GB（8GB×2）",
    janCode: "73513537",
    serialRequired: "on",
    keepBox: "on",
    makerWarrantyMonths: "",
  };

  it("追加すると、仕入れ・下書きの選択肢に出る。在庫0・構成表になし", async () => {
    const r = await createPartModel(owner, part(base));
    if (!r.ok) throw new Error(r.message);
    id = r.id;
    expect(r.message).toBe("DDR4-3200 16GB（8GB×2）（DDR4-3200-8X2）を追加しました。");
    expect((await listPartModels()).some((m) => m.id === id)).toBe(true);
    expect(await getPartModel(id)).toMatchObject({ inStock: 0, skuCount: 0, active: true, keepBox: true });
  });

  it("同じメーカー・型番、同じJANは二重に登録しない", async () => {
    expect(await createPartModel(owner, part(base))).toEqual({
      ok: false,
      message: "同じメーカー・同じ型番が、もう登録されています。",
    });
    expect(await createPartModel(owner, part({ ...base, modelNo: "OTHER-1" }))).toEqual({
      ok: false,
      message: "このJANコードは、ほかの型番に登録されています。",
    });
  });

  it("名前などを直せる。「使わない」にすると選択肢から消えるが、一覧には残る", async () => {
    expect(await updatePartModel(owner, id, part({ ...base, name: "DDR4 16GB", active: "" }))).toMatchObject({ ok: true });
    expect(await getPartModel(id)).toMatchObject({ name: "DDR4 16GB", active: false });
    expect((await listPartModels()).some((m) => m.id === id)).toBe(false);
    expect((await listAllPartModels()).some((m) => m.id === id)).toBe(true);
    expect(await updatePartModel(owner, 999999, part(base))).toMatchObject({ ok: false });
  });

  it("型番・名前・JANで探せる（% や _ はそのままの文字として探す）", async () => {
    expect((await listAllPartModels("ddr4-3200")).map((m) => m.id)).toEqual([id]);
    expect((await listAllPartModels("73513537")).map((m) => m.id)).toEqual([id]);
    expect(await listAllPartModels("%")).toEqual([]);
    expect((await listAllPartModels("")).length).toBeGreaterThan(10);
  });

  it("ダミーデータの型番は、在庫数と使える機種の数が出る", async () => {
    const gpu = (await listAllPartModels("RTX5070-A12G"))[0];
    expect(gpu.skuCount).toBe(1);
    const [stock] = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.part_items WHERE part_model_id = $1 AND status = 'in_stock'",
      [gpu.id],
    );
    expect(gpu.inStock).toBe(stock.n);
  });
});

describe("仕入先", () => {
  it("追加・変更でき、同じ名前は二重に登録しない", async () => {
    const r = await createSupplier(owner, supplier({ name: "ツクモ通販", kind: "shop", invoiceRegNo: "T1234567890123" }));
    if (!r.ok) throw new Error(r.message);
    expect((await listSuppliers()).some((s) => s.id === r.id)).toBe(true);
    expect(await createSupplier(owner, supplier({ name: "ツクモ通販", kind: "shop" }))).toEqual({
      ok: false,
      message: "同じ名前の仕入先が、もう登録されています。",
    });
    expect(
      await updateSupplier(owner, r.id, supplier({ name: "ツクモ通販", kind: "shop", rmaContact: "rma@tsukumo.example" })),
    ).toMatchObject({ ok: true });
    expect(await getSupplier(r.id)).toMatchObject({ rmaContact: "rma@tsukumo.example", invoiceRegNo: null, purchaseCount: 0 });
    expect(await updateSupplier(owner, r.id, supplier({ name: "ドスパラ", kind: "shop" }))).toMatchObject({ ok: false });
  });

  it("一覧に仕入れの件数が出る", async () => {
    const rows = await listAllSuppliers();
    expect(rows.find((s) => s.name === "ドスパラ")?.purchaseCount).toBeGreaterThan(0);
  });
});
