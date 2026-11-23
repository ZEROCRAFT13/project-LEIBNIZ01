// 自社出荷の作り方・出品数・ToDo（テスト用 DB。まねた SP-API）。
// ほかのテストの個体に左右されないよう、このテスト専用の機種 ZB-PLAN-TEST を作る（部品・構成表・自社出荷用の出品つき）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ListingQtyApi } from "@/lib/amazon/sp-api";
import { startUnit } from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import { getFbmPlanRows, sendListingQuantities, updateFbmPlanTasks } from "@/lib/fbm-plan";

let owner: number;
let sato: number;
let sku: number;
const SELLER = "A1SELLER0TEST";

async function readyUnit(): Promise<string> {
  const m = await startUnit(sato, sku);
  await query(`UPDATE core.units SET status = 'ready', assembled_at = now(), inspected_at = now() WHERE mgmt_no = $1`, [m]);
  return m;
}

const row = async () => (await getFbmPlanRows()).find((r) => r.skuId === sku)!;
const task = async (ref: string) =>
  (await query<{ title: string; status: string; role_code: string }>(
    `SELECT title, status, role_code FROM core.tasks WHERE source_ref = $1 ORDER BY id DESC LIMIT 1`,
    [ref],
  ))[0];
const outbound = () =>
  query<{ status: string; error: string | null; payload: { quantity: number } }>(
    `SELECT status, error, payload FROM core.outbound_actions WHERE kind = 'amazon_listing_qty' AND subject_id = $1 ORDER BY id`,
    [sku],
  );

function fakeApi(result: { status: string; issues: { code: string; severity: string }[] } = { status: "ACCEPTED", issues: [] }) {
  const sent: { sellerSku: string; quantity: number; productType: string }[] = [];
  const api: ListingQtyApi = {
    async getListing(_sellerId, sellerSku) {
      return sellerSku === "ZB-PLAN-TEST-FBM" ? { productType: "PERSONAL_COMPUTER", quantity: 0 } : null;
    },
    async setListingQuantity(_sellerId, sellerSku, productType, quantity) {
      sent.push({ sellerSku, quantity, productType });
      return result;
    },
  };
  return { api, sent };
}

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;
  [{ id: sku }] = await query<{ id: number }>(
    `INSERT INTO core.skus (code, name, list_price, amazon_fulfillment, fbm_policy, fbm_stock_target)
     VALUES ('ZB-PLAN-TEST', 'テスト用の高額機種', 599800, 'fbm', 'stock', 2) RETURNING id`,
  );
  await query(`INSERT INTO core.amazon_listings (sku_id, fulfillment, seller_sku, asin) VALUES ($1, 'fbm', 'ZB-PLAN-TEST-FBM', 'B0ZBPLAN01')`, [sku]);
  const [{ id: gpu }] = await query<{ id: number }>(
    `INSERT INTO core.part_models (category, maker, model_no, name, serial_required) VALUES ('gpu', 'TEST', 'PLAN-GPU', 'テストGPU', false) RETURNING id`,
  );
  const [{ id: mem }] = await query<{ id: number }>(
    `INSERT INTO core.part_models (category, maker, model_no, name, serial_required) VALUES ('memory', 'TEST', 'PLAN-MEM', 'テストメモリ', false) RETURNING id`,
  );
  const [{ id: gpuSlot }] = await query<{ id: number }>(
    `INSERT INTO core.sku_slots (sku_id, slot, category, qty) VALUES ($1, 'GPU', 'gpu', 1) RETURNING id`,
    [sku],
  );
  const [{ id: memSlot }] = await query<{ id: number }>(
    `INSERT INTO core.sku_slots (sku_id, slot, category, qty) VALUES ($1, 'MEMORY', 'memory', 2) RETURNING id`,
    [sku],
  );
  await query(`INSERT INTO core.sku_slot_options (slot_id, part_model_id) VALUES ($1, $2), ($3, $4)`, [gpuSlot, gpu, memSlot, mem]);
  // GPU 3枚、メモリ 5枚（2枚ずつ）→ 部品で組めるのは 2台
  await query(
    `INSERT INTO core.part_items (part_model_id, cost_excl_tax) SELECT $1::bigint, 100000 FROM generate_series(1, 3)
     UNION ALL SELECT $2::bigint, 10000 FROM generate_series(1, 5)`,
    [gpu, mem],
  );
});

afterAll(async () => {
  await getPool().end();
});

describe("作り置きの機種", () => {
  it("出荷待ちが 0 なら出す数は 0、目標まであと2台。ToDo（工場長に組立、代表に出品数）ができる", async () => {
    expect(await row()).toMatchObject({ policy: "stock", ready: 0, buildable: 2, qty: 0, shortage: 2, lastQty: null, changed: true });
    const s = await updateFbmPlanTasks();
    expect(s.stockCreated).toBeGreaterThanOrEqual(1);
    expect(await task(`fbm-stock:sku:${sku}`)).toMatchObject({
      title: "自社出荷の作り置き：ZB-PLAN-TEST を 2台組み立てる",
      status: "todo",
      role_code: "factory_manager",
    });
    expect(await task("fbm-listing-qty")).toMatchObject({ status: "todo", role_code: "ceo" });
  });

  it("組み立てて出荷待ちが2台になったら、作り置きの ToDo は閉じる。出す数は2台", async () => {
    await readyUnit();
    await readyUnit();
    expect(await row()).toMatchObject({ ready: 2, qty: 2, shortage: 0 });
    await updateFbmPlanTasks();
    expect(await task(`fbm-stock:sku:${sku}`)).toMatchObject({ status: "done" });
  });

  it("画面の数で承認して送る。送れたら「最後に送った数」になる", async () => {
    const { api, sent } = fakeApi();
    const r = await sendListingQuantities(owner, new Map([[sku, 2]]), api, SELLER);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("ZB-PLAN-TEST 2台") });
    expect(sent).toEqual([{ sellerSku: "ZB-PLAN-TEST-FBM", quantity: 2, productType: "PERSONAL_COMPUTER" }]);
    expect(await outbound()).toMatchObject([{ status: "sent", payload: { quantity: 2 } }]);
    expect(await row()).toMatchObject({ lastQty: 2, changed: false });
  });

  it("画面を開いたあとで数が変わっていたら送らない。出品者 ID・キーがなければ送らない", async () => {
    const { api, sent } = fakeApi();
    expect(await sendListingQuantities(owner, new Map([[sku, 5]]), api, SELLER)).toMatchObject({
      ok: false,
      message: expect.stringContaining("数が変わりました"),
    });
    expect(await sendListingQuantities(owner, new Map([[sku, 2]]), api, null)).toMatchObject({ ok: false, message: expect.stringContaining("出品者 ID") });
    expect(await sendListingQuantities(owner, new Map([[sku, 2]]), null, SELLER)).toMatchObject({ ok: false, message: expect.stringContaining("キー") });
    expect(sent).toEqual([]);
    expect(await outbound()).toHaveLength(1);
  });
});

describe("注文を受けてから組む・両方の機種", () => {
  it("注文を受けてから組むなら、出荷待ち＋部品で組める台数（上限まで）を出す。Amazon が受け付けなければ理由を残す", async () => {
    await query(`UPDATE core.skus SET fbm_policy = 'to_order', fbm_max_to_order = 1 WHERE id = $1`, [sku]);
    expect(await row()).toMatchObject({ qty: 3, shortage: 0, changed: true }); // 出荷待ち2＋組める2のうち上限1
    const { api } = fakeApi({ status: "INVALID", issues: [{ code: "90220", severity: "ERROR" }, { code: "1", severity: "WARNING" }] });
    const r = await sendListingQuantities(owner, new Map([[sku, 3]]), api, SELLER);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("90220") });
    expect((await outbound()).at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("INVALID") });
    expect(await row()).toMatchObject({ lastQty: 2, changed: true });
  });

  it("両方の機種は、FBA に販売できる在庫があるあいだ 0 を出す", async () => {
    await query(`UPDATE core.skus SET amazon_fulfillment = 'both' WHERE id = $1`, [sku]);
    await query(`INSERT INTO core.fba_inventory_snapshots (captured_at, sku_id, fulfillable, inbound) VALUES (now(), $1, 4, 0)`, [sku]);
    expect(await row()).toMatchObject({ qty: 0, why: expect.stringContaining("FBA 4台") });
    await query(`UPDATE core.skus SET amazon_fulfillment = 'fbm', fbm_policy = 'stock' WHERE id = $1`, [sku]);
  });

  it("出す数が最後に送った数とそろったら、出品数の ToDo は閉じる", async () => {
    // ほかの機種（ダミーデータ）の数もそろえる
    const { api } = fakeApi();
    const rows = await getFbmPlanRows();
    const others = rows.filter((r) => r.changed && r.skuId !== sku);
    const fake: ListingQtyApi = { ...api, async getListing() { return { productType: "PERSONAL_COMPUTER", quantity: 0 }; } };
    await sendListingQuantities(owner, new Map([...others.map((r) => [r.skuId, r.qty] as [number, number]), [sku, (await row()).qty]]), fake, SELLER);
    await updateFbmPlanTasks();
    expect(await task("fbm-listing-qty")).toMatchObject({ status: "done" });
  });
});
