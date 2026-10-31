// 付けなくてもよい枠・自由枠・個体のメモが、組立でどう働くか（ダミーデータの DB に対して）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUnitNote,
  finishAssembly,
  getAssembly,
  listInProgress,
  removeUnitNote,
  scanPart,
  startUnit,
} from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import { parseSkuInput } from "@/lib/sku-calc";
import { getUnitTrace } from "@/lib/trace";
import { addOption, createSku, getSkuDetail, removeSlot, setSlotRequired } from "./skus";

let owner: number;
let sato: number;
let skuId: number;
let mgmtNo: string;

async function stock(modelNo: string, serial: string): Promise<void> {
  await query(
    `INSERT INTO core.part_items (part_model_id, serial_no, cost_excl_tax, cost_tax)
     SELECT id, $2, 1000, 100 FROM core.part_models WHERE model_no = $1`,
    [modelNo, serial],
  );
}

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;

  // ひな形から作り、CPU（必ず付ける）・ケースファン（付けなくてもよい）・自由枠 だけ残した小さな機種にする
  const input = parseSkuInput({ code: "ZB-OPT-1", name: "枠のテスト" });
  if (!input.ok) throw new Error();
  const r = await createSku(owner, input.value, null);
  if (!r.ok) throw new Error(r.message);
  skuId = r.id;
  const sku = (await getSkuDetail(skuId))!;
  for (const s of sku.slots.filter((s) => !["CPU", "FAN", "EXTRA"].includes(s.slot))) await removeSlot(owner, s.id);
  const cpuModel = (await query<{ id: number }>("SELECT id FROM core.part_models WHERE model_no = '100-100001404WOF'"))[0].id;
  await addOption(owner, sku.slots.find((s) => s.slot === "CPU")!.id, cpuModel);

  await stock("100-100001404WOF", "OPT-CPU-1");
  await stock("RTX5060TI-A16G", "OPT-GPU-1"); // この機種の構成表にない部品（自由枠に入る）
  mgmtNo = await startUnit(sato, skuId);
});

afterAll(async () => {
  await getPool().end();
});

describe("付けなくてもよい枠", () => {
  it("進み具合は「必ず付ける」枠だけで数え、付けなくてもよい枠は「次はこれ」にならない", async () => {
    const v = (await getAssembly(mgmtNo))!;
    expect(v).toMatchObject({ total: 1, filled: 0, nextSlot: "CPU" });
    expect(v.slots.map((s) => [s.slot, s.required, s.anyPart])).toEqual([
      ["CPU", true, false],
      ["FAN", false, false],
      ["EXTRA", false, true],
    ]);
    expect(v.slots.find((s) => s.slot === "EXTRA")?.options).toEqual(["登録済みの部品なら何でも"]);
  });

  it("CPU を付けると、ケースファンなしで完了できる状態になる", async () => {
    expect(await scanPart(sato, mgmtNo, "OPT-CPU-1")).toMatchObject({ kind: "installed", slot: "CPU" });
    const v = (await getAssembly(mgmtNo))!;
    expect(v).toMatchObject({ total: 1, filled: 1, nextSlot: null });
    expect((await listInProgress()).find((u) => u.mgmtNo === mgmtNo)).toMatchObject({ filled: 1, total: 1 });
  });
});

describe("自由枠", () => {
  it("構成表にない部品でも、自由枠があればそこに付く（型番の決まった枠が先）", async () => {
    expect(await scanPart(sato, mgmtNo, "OPT-GPU-1")).toMatchObject({ kind: "installed", slot: "EXTRA" });
    const v = (await getAssembly(mgmtNo))!;
    expect(v.slots.find((s) => s.slot === "EXTRA")?.installed.map((i) => i.serialNo)).toEqual(["OPT-GPU-1"]);
    expect(v).toMatchObject({ total: 1, filled: 1 }); // 自由枠は進み具合に数えない
  });
});

describe("個体のメモ", () => {
  let noteId: number;

  it("メモを残し、個体の履歴にも出る。空や長すぎるメモは断る", async () => {
    expect(await addUnitNote(sato, mgmtNo, "  LEDテープを追加  ")).toEqual({ ok: true, message: "メモを残しました。" });
    expect(await addUnitNote(sato, mgmtNo, "   ")).toMatchObject({ ok: false });
    expect(await addUnitNote(sato, mgmtNo, "x".repeat(201))).toMatchObject({ ok: false });
    const v = (await getAssembly(mgmtNo))!;
    expect(v.notes.map((n) => [n.note, n.by])).toEqual([["LEDテープを追加", "佐藤（バイト）"]]);
    noteId = v.notes[0].id;
    expect((await getUnitTrace(mgmtNo))?.workNotes.map((n) => n.note)).toEqual(["LEDテープを追加"]);
  });

  it("取り消すと出なくなる（記録は残る）", async () => {
    expect(await removeUnitNote(sato, mgmtNo, noteId)).toMatchObject({ ok: true });
    expect(await removeUnitNote(sato, mgmtNo, noteId)).toMatchObject({ ok: false });
    expect((await getAssembly(mgmtNo))?.notes).toEqual([]);
    const [row] = await query<{ removed: boolean }>("SELECT removed_at IS NOT NULL AS removed FROM core.unit_notes WHERE id = $1", [
      noteId,
    ]);
    expect(row.removed).toBe(true);
  });
});

describe("完了と「必ず付ける」への切り替え", () => {
  it("ケースファンを「必ず付ける」にすると、付くまで完了できない。戻せば完了できる", async () => {
    const fan = (await getSkuDetail(skuId))!.slots.find((s) => s.slot === "FAN")!;
    await setSlotRequired(owner, fan.id, true);
    expect(await finishAssembly(sato, mgmtNo)).toEqual({ ok: false, message: "まだ付いていない部品があります：ケースファン" });
    await setSlotRequired(owner, fan.id, false);
    expect(await finishAssembly(sato, mgmtNo)).toMatchObject({ ok: true });
    expect((await getAssembly(mgmtNo))?.status).toBe("inspecting");
  });

  it("組立が終わった個体には、メモを足せない", async () => {
    expect(await addUnitNote(sato, mgmtNo, "あとから")).toMatchObject({ ok: false });
  });
});
