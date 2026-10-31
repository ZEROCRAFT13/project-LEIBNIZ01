// 管理番号シールの一覧・刷った記録・QR（ダミーデータの DB に対して）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanPart, startUnit } from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import { labelUrl } from "@/lib/label-calc";
import { getLabelUnits, listLabelUnits, markLabelsPrinted, qrSvg } from "@/lib/label-print";

let sato: number;
let first: string;
let second: string;

beforeAll(async () => {
  sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;
  const [sku] = await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'");
  first = await startUnit(sato, sku.id);
  second = await startUnit(sato, sku.id);
});

afterAll(async () => {
  await getPool().end();
});

describe("シールの一覧", () => {
  it("発行したばかりの個体は、まだ刷っていないものとして出る", async () => {
    const list = await listLabelUnits();
    const mine = list.filter((u) => u.mgmtNo === first || u.mgmtNo === second);
    expect(mine).toHaveLength(2);
    expect(mine.every((u) => u.printedAt === null && u.skuCode === "ZB-G5070-R7")).toBe(true);
  });

  it("頼んだ順に返し、ない番号は飛ばす", async () => {
    const units = await getLabelUnits([second, "ZB-9999-9999", first]);
    expect(units.map((u) => u.mgmtNo)).toEqual([second, first]);
    expect(await getLabelUnits([])).toEqual([]);
  });
});

describe("刷った記録", () => {
  it("刷った印を付けると、一覧で下（刷ったもの）に回る", async () => {
    expect(await markLabelsPrinted(sato, [first])).toBe(1);
    const list = await listLabelUnits();
    const idxFirst = list.findIndex((u) => u.mgmtNo === first);
    const idxSecond = list.findIndex((u) => u.mgmtNo === second);
    expect(list[idxFirst].printedAt).toBeInstanceOf(Date);
    expect(idxSecond).toBeLessThan(idxFirst);
    // まだ刷っていないものは、すべて刷ったものより上
    const lastUnprinted = list.findLastIndex((u) => !u.printedAt);
    const firstPrinted = list.findIndex((u) => u.printedAt);
    expect(lastUnprinted).toBeLessThan(firstPrinted);
  });

  it("刷り直すと、時刻が新しくなる", async () => {
    const [before] = await getLabelUnits([first]);
    await new Promise((r) => setTimeout(r, 20));
    expect(await markLabelsPrinted(sato, [first])).toBe(1);
    const [after] = await getLabelUnits([first]);
    expect(after.printedAt!.getTime()).toBeGreaterThan(before.printedAt!.getTime());
  });

  it("ない番号や空では何もしない", async () => {
    expect(await markLabelsPrinted(sato, [])).toBe(0);
    expect(await markLabelsPrinted(sato, ["ZB-9999-9999"])).toBe(0);
  });
});

describe("QR", () => {
  it("URL を QR の SVG にする（余白なし）", async () => {
    const svg = await qrSvg(labelUrl("https://zero-bit.jp", first));
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 (\d+) \1"/);
    expect(svg).toContain("<path");
  });

  it("組立の画面でシールの QR を読むと、その個体へ移る", async () => {
    const r = await scanPart(sato, first, labelUrl("https://zero-bit.jp", second));
    expect(r).toMatchObject({ kind: "unit", mgmtNo: second });
    const self = await scanPart(sato, first, labelUrl(undefined, first));
    expect(self.kind).toBe("error");
  });
});
