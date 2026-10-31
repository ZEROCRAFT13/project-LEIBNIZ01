// 仕入れの下書き（メールから作る → 確かめて確定 → 型番の対応を覚える）のテスト
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, query } from "@/lib/db";
import { getPurchase } from "@/lib/purchasing";
import { dosparaMail } from "@/test/mail-fixtures";
import { confirmDraft, createDraftFromMail, discardDraft, getDraft, listOpenDrafts } from "./purchase-drafts";

let owner: number;
let dospara: number;
let b850: number;
let nvme: number;

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  dospara = (await query<{ id: number }>("SELECT id FROM core.suppliers WHERE name = 'ドスパラ'"))[0].id;
  b850 = (await query<{ id: number }>("SELECT id FROM core.part_models WHERE model_no = 'B850-ATX'"))[0].id;
  nvme = (await query<{ id: number }>("SELECT id FROM core.part_models WHERE model_no = 'NV4-1TB'"))[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("メールから下書きを作って確定する", () => {
  let draftId: number;

  it("貼り付けたメールから下書きができる。本文（宛名・住所）は保存しない", async () => {
    const r = await createDraftFromMail(owner, dosparaMail({ orderNo: "EC0000000101", shipping: 880 }));
    if (!r.ok) throw new Error(r.message);
    draftId = r.id;
    const d = await getDraft(draftId);
    expect(d).toMatchObject({
      parser: "dospara",
      supplierId: dospara,
      orderNo: "EC0000000101",
      orderedOn: "2026-10-30",
      paymentMethod: "card",
      total: 89780,
      issues: [],
      status: "open",
    });
    expect(d?.lines.map((l) => [l.kind, l.suggestedModelId])).toEqual([
      ["item", null],
      ["item", null],
      ["fee", null],
    ]);
    const [row] = await query<{ all: string }>("SELECT row_to_json(d)::text AS all FROM core.purchase_drafts d WHERE id = $1", [
      draftId,
    ]);
    expect(row.all).not.toContain("見本 太郎");
    expect(row.all).not.toContain("大阪府");
    expect((await listOpenDrafts()).map((x) => x.id)).toContain(draftId);
  });

  it("同じ注文の下書きは二重に作らない", async () => {
    const r = await createDraftFromMail(owner, dosparaMail({ orderNo: "EC0000000101" }));
    expect(r).toEqual({ ok: false, message: "この注文の下書きは、もうあります。", existingDraftId: draftId });
  });

  it("部品を選ばない行があると確定できない", async () => {
    const r = await confirmDraft(owner, draftId, {
      supplierId: dospara,
      orderedOn: "2026-10-30",
      paymentMethod: "card",
      choices: [{ partModelId: b850 }, { partModelId: 0 }, { other: true }],
    });
    expect(r).toEqual({ ok: false, message: "2行目：部品を選んでください。" });
  });

  it("確定すると仕入れになり、明細・合計・消費税がそろう。選んだ型番を覚える", async () => {
    const r = await confirmDraft(owner, draftId, {
      supplierId: dospara,
      orderedOn: "2026-10-30",
      paymentMethod: "card",
      choices: [{ partModelId: b850 }, { partModelId: nvme }, { other: true }],
    });
    if (!r.ok) throw new Error(r.message);
    const p = await getPurchase(r.purchaseId);
    expect(p).toMatchObject({ supplier: "ドスパラ", orderNo: "EC0000000101", total: 89780, tax: 8162, status: "ordered" });
    expect(p?.lines.map((l) => [l.model?.id ?? null, l.qty, l.unitPrice])).toEqual([
      [b850, 2, 24980],
      [nvme, 3, 12980],
      [null, 1, 880],
    ]);
    expect(await getDraft(draftId)).toMatchObject({ status: "confirmed", purchaseId: r.purchaseId });
    // 二度は確定できない
    expect(
      await confirmDraft(owner, draftId, {
        supplierId: dospara,
        orderedOn: "2026-10-30",
        paymentMethod: "card",
        choices: [{ partModelId: b850 }, { partModelId: nvme }, { other: true }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("次の同じ商品は、覚えた型番が最初から選ばれる（全角・空白のちがいも同じ商品と見なす）", async () => {
    const r = await createDraftFromMail(
      owner,
      dosparaMail({
        orderNo: "EC0000000102",
        items: [
          { name: "メーカーC  B850 ATX (B850 AM5 ATX)", unit: 24980, qty: 1 },
          { name: "新しい商品 XYZ", unit: 1000, qty: 1 },
        ],
      }),
    );
    if (!r.ok) throw new Error(r.message);
    expect((await getDraft(r.id))?.lines.map((l) => l.suggestedModelId)).toEqual([b850, null]);
  });

  it("仕入れとして登録済みの注文は、下書きにしない", async () => {
    const r = await createDraftFromMail(owner, dosparaMail({ orderNo: "EC0000000101" }));
    expect(r).toMatchObject({ ok: false, message: "この注文は、もう仕入れとして登録されています。" });
  });
});

describe("確定できないとき・捨てるとき", () => {
  it("メールの合計と明細の合計が合わなければ、確定しない", async () => {
    const r = await createDraftFromMail(owner, dosparaMail({ orderNo: "EC0000000103", total: 80000 }));
    if (!r.ok) throw new Error(r.message);
    expect((await getDraft(r.id))?.issues).toHaveLength(1);
    const c = await confirmDraft(owner, r.id, {
      supplierId: dospara,
      orderedOn: "2026-10-30",
      paymentMethod: "card",
      choices: [{ partModelId: b850 }, { partModelId: nvme }],
    });
    expect(c).toMatchObject({ ok: false, message: expect.stringContaining("合わないので、確定できません") });
  });

  it("捨てた下書きは一覧から消え、同じ注文で作り直せる", async () => {
    const r = await createDraftFromMail(owner, dosparaMail({ orderNo: "EC0000000104" }));
    if (!r.ok) throw new Error(r.message);
    expect(await discardDraft(owner, r.id)).toBe(true);
    expect(await discardDraft(owner, r.id)).toBe(false);
    expect((await listOpenDrafts()).some((d) => d.id === r.id)).toBe(false);
    expect(await createDraftFromMail(owner, dosparaMail({ orderNo: "EC0000000104" }))).toMatchObject({ ok: true });
  });

  it("対応していないメールや空の本文は、そう伝える", async () => {
    expect(await createDraftFromMail(owner, "こんにちは")).toMatchObject({ ok: false, message: expect.stringContaining("対応しているショップ") });
    expect(await createDraftFromMail(owner, "  ")).toMatchObject({ ok: false, message: "メールの本文を貼り付けてください。" });
  });
});
