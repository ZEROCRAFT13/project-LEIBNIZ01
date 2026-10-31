// 機種と構成表（ダミーデータの DB に対して）。組立のチェックにつながることも確かめる
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanPart, startUnit } from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import { parsePartModelInput } from "@/lib/master-calc";
import { createPartModel, updatePartModel } from "@/lib/masters";
import { parseSkuInput } from "@/lib/sku-calc";
import {
  addOption,
  addSlot,
  createSku,
  getSkuDetail,
  listSkusWithSummary,
  removeOption,
  removeSlot,
  setSlotQty,
  slotsForPartModel,
  updateSku,
} from "./skus";

let owner: number;
let sato: number;
let base: number; // ZB-G5070-R7

const sku = (raw: Record<string, unknown>) => {
  const r = parseSkuInput(raw);
  if (!r.ok) throw new Error(r.errors.join());
  return r.value;
};

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;
  base = (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'"))[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("機種を作る", () => {
  it("ひな形から作ると、CPU〜OS の9枠が空でできる", async () => {
    const r = await createSku(owner, sku({ code: "ZB-NEW-1", name: "新しい機種" }), null);
    if (!r.ok) throw new Error(r.message);
    const d = await getSkuDetail(r.id);
    expect(d?.slots.map((s) => [s.slot, s.qty, s.options.length])).toEqual(
      ["CPU", "GPU", "MB", "MEMORY", "SSD", "PSU", "COOLER", "CASE", "OS"].map((s) => [s, 1, 0]),
    );
    expect((await listSkusWithSummary()).find((k) => k.id === r.id)).toMatchObject({ slotCount: 9, emptySlots: 9 });
  });

  it("もとにする機種を選ぶと、枠と使ってよい型番を写す（もとの機種は変わらない）", async () => {
    const r = await createSku(owner, sku({ code: "ZB-G5070-R7B", name: "5070 の別構成", listPrice: "359800" }), base);
    if (!r.ok) throw new Error(r.message);
    const [copy, orig] = [await getSkuDetail(r.id), await getSkuDetail(base)];
    expect(copy?.slots.map((s) => [s.slot, s.options.map((o) => o.modelNo)])).toEqual(
      orig?.slots.map((s) => [s.slot, s.options.map((o) => o.modelNo)]),
    );
    expect(copy?.listPrice).toBe(359800);
  });

  it("同じ機種コードは作れない", async () => {
    expect(await createSku(owner, sku({ code: "ZB-G5070-R7", name: "x" }), null)).toEqual({
      ok: false,
      message: "同じ機種コードが、もう登録されています。",
    });
  });
});

describe("構成表を直す", () => {
  let skuId: number;
  let newGpu: number;

  beforeAll(async () => {
    const r = await createSku(owner, sku({ code: "ZB-EDIT-1", name: "直す機種" }), base);
    if (!r.ok) throw new Error(r.message);
    skuId = r.id;
    const m = parsePartModelInput({ category: "gpu", maker: "メーカーZ", modelNo: "RTX5070-Z12G", name: "RTX 5070 Z", serialRequired: "on" });
    if (!m.ok) throw new Error();
    const c = await createPartModel(owner, m.value);
    if (!c.ok) throw new Error(c.message);
    newGpu = c.id;
  });

  const gpuSlot = async () => (await getSkuDetail(skuId))!.slots.find((s) => s.slot === "GPU")!;

  it("新しい型番を枠に足す・外す。同じものは二度足さない。種類のちがう型番は足せない", async () => {
    const slot = await gpuSlot();
    expect(await addOption(owner, slot.id, newGpu)).toMatchObject({ ok: true });
    expect(await addOption(owner, slot.id, newGpu)).toEqual({ ok: false, message: "その型番は、もうこの枠に入っています。" });
    expect((await gpuSlot()).options.map((o) => o.modelNo)).toContain("RTX5070-Z12G");
    const memory = (await query<{ id: number }>("SELECT id FROM core.part_models WHERE model_no = 'D5-5600-16X2'"))[0].id;
    expect(await addOption(owner, slot.id, memory)).toEqual({
      ok: false,
      message: "この枠（gpu）には、種類のちがう部品（memory）は入れられません",
    });
    expect(await removeOption(owner, slot.id, newGpu)).toMatchObject({ ok: true });
    expect(await removeOption(owner, slot.id, newGpu)).toMatchObject({ ok: false });
  });

  it("型番の画面から見ると、使っている枠と足せる枠が分かる", async () => {
    const slot = await gpuSlot();
    await addOption(owner, slot.id, newGpu);
    const s = await slotsForPartModel(newGpu);
    expect(s.using.map((u) => u.skuCode)).toEqual(["ZB-EDIT-1"]);
    expect(s.available.map((u) => u.skuCode)).toContain("ZB-G5070-R7");
    expect([...s.using, ...s.available].every((u) => u.slot === "GPU")).toBe(true);
  });

  it("構成表で使っている型番は、種類を変えられない", async () => {
    const m = parsePartModelInput({ category: "other", maker: "メーカーZ", modelNo: "RTX5070-Z12G", name: "RTX 5070 Z", serialRequired: "on" });
    if (!m.ok) throw new Error();
    expect(await updatePartModel(owner, newGpu, m.value)).toMatchObject({ ok: false, message: expect.stringContaining("種類を変えられません") });
  });

  it("枠を足す・数を変える・消す", async () => {
    const r = await addSlot(owner, skuId, { slot: "FAN_FRONT", category: "fan", qty: 2 });
    if (!r.ok) throw new Error(r.message);
    expect(await addSlot(owner, skuId, { slot: "FAN_FRONT", category: "fan", qty: 1 })).toEqual({
      ok: false,
      message: "同じ名前の枠が、もうあります。",
    });
    expect(await setSlotQty(owner, r.id, 3)).toMatchObject({ ok: true });
    expect(await setSlotQty(owner, r.id, 0)).toMatchObject({ ok: false });
    expect((await getSkuDetail(skuId))!.slots.at(-1)).toMatchObject({ slot: "FAN_FRONT", qty: 3 });
    expect(await removeSlot(owner, r.id)).toEqual({ ok: true, id: r.id, message: "枠「FAN_FRONT」を消しました。" });
  });

  it("名前・定価・使うかどうかを直せる（機種コードは変わらない）", async () => {
    expect(await updateSku(owner, skuId, sku({ code: "ZB-OTHER", name: "名前を変えた", listPrice: "100", active: "" }))).toMatchObject({
      ok: true,
    });
    expect(await getSkuDetail(skuId)).toMatchObject({ code: "ZB-EDIT-1", name: "名前を変えた", listPrice: 100, active: false });
    await updateSku(owner, skuId, sku({ code: "ZB-EDIT-1", name: "直す機種", active: "on" }));
  });

  let openUnit: string;

  it("組立中の個体がある機種の枠は消せない（理由を出す）", async () => {
    openUnit = await startUnit(sato, skuId);
    const slot = await gpuSlot();
    expect(await removeSlot(owner, slot.id)).toMatchObject({ ok: false, message: expect.stringContaining("組立中の個体がある機種") });
    expect((await getSkuDetail(skuId))?.openUnits).toBe(1);
  });

  it("新しい型番は、構成表に足すまで組立で止まり、足すと読める", async () => {
    // 新しい GPU の型番と、その部品1個（入荷済みとする）
    const m = parsePartModelInput({ category: "gpu", maker: "メーカーY", modelNo: "RTX5070-Y12G", name: "RTX 5070 Y", serialRequired: "on" });
    if (!m.ok) throw new Error();
    const c = await createPartModel(owner, m.value);
    if (!c.ok) throw new Error(c.message);
    await query(
      `INSERT INTO core.part_items (part_model_id, serial_no, cost_excl_tax, cost_tax) VALUES ($1, 'Y12G-0001', 90000, 9000)`,
      [c.id],
    );
    const before = await scanPart(sato, openUnit, "Y12G-0001");
    expect(before).toMatchObject({ kind: "error", message: expect.stringContaining("この機種の構成表にありません") });

    expect(await addOption(owner, (await gpuSlot()).id, c.id)).toMatchObject({ ok: true });
    const after = await scanPart(sato, openUnit, "Y12G-0001");
    expect(after).toMatchObject({ kind: "installed", slot: "GPU" });
  });
});
