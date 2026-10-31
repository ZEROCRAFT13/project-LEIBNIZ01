// 個体トレースのテスト。db/seeds/0001_dev_seed.sql のダミーデータが入ったDBに対して動かす
import { afterAll, describe, expect, it } from "vitest";
import { getPool, query, withActor } from "@/lib/db";
import { yen, ymd } from "@/lib/format";
import { getUnitTrace, normalizeQuery, partTotals, searchUnits, warrantyState } from "@/lib/trace";

afterAll(async () => {
  await getPool().end();
});

describe("入力をそろえる", () => {
  it.each([
    ["ZB-2609-0118", "ZB-2609-0118"],
    ["zb-2609-0118", "ZB-2609-0118"],
    ["ｚｂ－２６０９－０１１８", "ZB-2609-0118"],
    ["2609-0118", "ZB-2609-0118"],
    ["ZB26090118", "ZB-2609-0118"],
    ["ZBー2609ー0118", "ZB-2609-0118"],
    [" 250-7712045-0003390 ", "250-7712045-0003390"],
    ["602-v531-4471", "602-V531-4471"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeQuery(input)).toBe(expected);
  });
});

describe("お金と保証の計算", () => {
  it("部品原価の合計と元箱の数", () => {
    expect(
      partTotals([
        { costInclTax: 98780, boxKept: true },
        { costInclTax: 52800, boxKept: false },
        { costInclTax: 0, boxKept: true },
      ]),
    ).toEqual({ partsCostInclTax: 151580, boxesKept: 2 });
    expect(partTotals([])).toEqual({ partsCostInclTax: 0, boxesKept: 0 });
  });

  it("保証は期限日の当日まで保証内", () => {
    expect(warrantyState("2027-09-21", "2027-09-21")).toBe("active");
    expect(warrantyState("2027-09-21", "2027-09-22")).toBe("expired");
    expect(warrantyState(null, "2027-09-22")).toBe("not_started");
  });

  it("金額と日付の表示（日本時間）", () => {
    expect(yen(269280)).toBe("¥269,280");
    expect(yen(null)).toBe("—");
    // 日本時間 2026-09-30 01:00 は UTC では前日
    expect(ymd(new Date("2026-09-29T16:00:00Z"))).toBe("2026-09-30");
    expect(ymd("2026-09-30")).toBe("2026-09-30");
  });
});

describe("検索", () => {
  it("管理番号で1台に決まる（全角でも）", async () => {
    const hits = await searchUnits("ｚｂ－２６０９－０１１８");
    expect(hits).toEqual([
      { mgmtNo: "ZB-2609-0118", skuCode: "ZB-G5070-R7", status: "in_repair", matchedBy: "mgmt_no", detail: null },
    ]);
  });

  it("Amazonの注文番号から個体が分かる", async () => {
    const hits = await searchUnits("250-7712045-0003390");
    expect(hits.map((h) => [h.mgmtNo, h.matchedBy])).toEqual([["ZB-2609-0118", "order"]]);
  });

  it("取り外した部品のシリアルからも、元の個体が分かる", async () => {
    const hits = await searchUnits("602-v531-3001");
    expect(hits).toHaveLength(1);
    expect(hits[0].mgmtNo).toBe("ZB-2609-0102");
    expect(hits[0].detail).toContain("取り外し済み");
  });

  it("見つからないときと、短すぎる入力は空", async () => {
    expect(await searchUnits("ZB-9999-9999")).toEqual([]);
    expect(await searchUnits("ZB")).toEqual([]);
  });

  it("SQLとして危ない文字を入れても、ただの文字として扱う", async () => {
    expect(await searchUnits("' OR 1=1 --")).toEqual([]);
  });
});

describe("個体1台の履歴", () => {
  it("ZB-2609-0118: 部品9点・原価 269,280円・元箱3点・登録で2年保証", async () => {
    const t = await getUnitTrace("ZB-2609-0118");
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.parts).toHaveLength(9);
    expect(t.parts.map((p) => p.slot)).toEqual(["CPU", "GPU", "MB", "MEMORY", "SSD", "PSU", "COOLER", "CASE", "OS"]);
    expect(t.totals).toEqual({ partsCostInclTax: 269280, boxesKept: 3 });
    expect(t.warranty).toMatchObject({ start: "2026-09-23", end: "2028-09-23", months: 24 });
    expect(t.order).toMatchObject({ externalOrderNo: "250-7712045-0003390", isFba: true, linkMethod: "product_registration" });
    expect(t.registration?.verification).toBe("verified");
    expect(t.assembledBy).toBe("佐藤（バイト）");
    expect(t.inspectedBy).toBe("代表");
    const psu = t.parts.find((p) => p.slot === "PSU");
    expect(psu).toMatchObject({ supplier: "ツクモ", serialNo: "PS85-2216", boxLocation: "C-03", costInclTax: 16480 });
    expect(t.repairs[0]).toMatchObject({ status: "received", coverage: "warranty" });
    expect(t.timeline.map((e) => e.label)).toEqual([
      "部品仕入れ",
      "組立",
      "検品",
      "FBAへ納品",
      "注文",
      "製品登録",
      "修理受付",
    ]);
  });

  it("ZB-2609-0102: 交換したGPUは「取り外した部品」に分かれ、RMAの状況も出る", async () => {
    const t = await getUnitTrace("ZB-2609-0102");
    if (!t) throw new Error("見つからない");
    expect(t.parts.filter((p) => p.slot === "GPU").map((p) => p.serialNo)).toEqual(["602-V531-3999"]);
    expect(t.removedParts).toHaveLength(1);
    expect(t.removedParts[0]).toMatchObject({
      serialNo: "602-V531-3001",
      rmaNo: "RMA-24-1188",
      rmaStatus: "sent",
      partStatus: "in_rma",
    });
    // 原価の合計には、今付いている部品だけを数える
    expect(t.totals.partsCostInclTax).toBe(269280);
  });

  it("ZB-2608-0077: 問い合わせで注文と紐づけた個体は、注文日から1年保証", async () => {
    const t = await getUnitTrace("ZB-2608-0077");
    expect(t?.warranty).toMatchObject({ start: "2026-08-26", end: "2027-08-26", months: 12 });
    expect(t?.registration).toBeNull();
  });

  it("ZB-2610-0045: 組立中・未出荷の個体", async () => {
    const t = await getUnitTrace("2610-0045");
    expect(t?.status).toBe("assembling");
    expect(t?.warranty.state).toBe("not_started");
    expect(t?.inspections).toEqual([]);
    expect(t?.parts).toHaveLength(7);
  });

  it("ない管理番号は null", async () => {
    expect(await getUnitTrace("ZB-9999-9999")).toBeNull();
  });
});

describe("DBの権限と監査", () => {
  it("アプリの接続（zb_app）では個人情報の表を読めない", async () => {
    await expect(query("SELECT * FROM pii.customer_profiles")).rejects.toThrow(/permission denied/);
  });

  it("書き込み用のトランザクションでは実行者が設定され、終わると消える", async () => {
    const inside = await withActor({ kind: "user", userId: 1 }, async (client) => {
      const r = await client.query(
        "SELECT current_setting('app.actor_kind') AS kind, current_setting('app.actor_user_id') AS uid",
      );
      return r.rows[0];
    });
    expect(inside).toEqual({ kind: "user", uid: "1" });
    const [after] = await query<{ kind: string | null }>(
      "SELECT nullif(current_setting('app.actor_kind', true), '') AS kind",
    );
    expect(after.kind).toBeNull();
  });

  it("途中でエラーになったら、書き込みは全部取り消される", async () => {
    await expect(
      withActor({ kind: "system" }, async (client) => {
        await client.query("UPDATE core.units SET notes = 'テスト' WHERE mgmt_no = 'ZB-2610-0045'");
        throw new Error("わざと失敗");
      }),
    ).rejects.toThrow("わざと失敗");
    const [u] = await query<{ notes: string | null }>("SELECT notes FROM core.units WHERE mgmt_no = 'ZB-2610-0045'");
    expect(u.notes).toBeNull();
  });
});
