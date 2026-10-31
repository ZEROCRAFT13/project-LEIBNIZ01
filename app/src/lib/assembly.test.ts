// 組立のテスト。db/seeds/0001_dev_seed.sql のダミーデータ（新しく1台組める在庫つき）に対して動かす。
// 既存の個体（ZB-2610-0045 など）は個体トレースのテストでも使うので、ここでは新しい個体を作って試す。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finishAssembly,
  getAssembly,
  getWorker,
  listInProgress,
  listWorkers,
  scanPart,
  startUnit,
  undoLast,
} from "@/lib/assembly";
import { normalizeCode } from "@/lib/codes";
import { getPool, query } from "@/lib/db";

let sato: number;
let mgmtNo: string;

beforeAll(async () => {
  const [u] = await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'");
  sato = u.id;
  const [sku] = await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'");
  mgmtNo = await startUnit(sato, sku.id);
});

afterAll(async () => {
  await getPool().end();
});

async function partStatus(serial: string) {
  const [r] = await query<{ status: string }>("SELECT status FROM core.part_items WHERE serial_no = $1", [serial]);
  return r.status;
}

describe("読み取った文字をそろえる", () => {
  it("日本語入力がオンのまま読んで全角になっても戻る", () => {
    expect(normalizeCode("ｐｓ８５－２３０２")).toBe("PS85-2302");
    expect(normalizeCode(" 9mp4c0501\n")).toBe("9MP4C0501");
  });
});

describe("組立をしてよい人", () => {
  it("組立担当と工場長の役割を持つ人だけ", async () => {
    const workers = await listWorkers();
    expect(workers.map((w) => w.name)).toEqual(["代表", "佐藤（バイト）", "高橋（バイト）"]);
    expect(await getWorker(9999)).toBeNull();
  });
});

describe("新しく1台組み立てる", () => {
  it("管理番号が発行され、組立中になる", async () => {
    expect(mgmtNo).toMatch(/^ZB-\d{4}-\d{4}$/);
    const view = await getAssembly(mgmtNo);
    expect(view).toMatchObject({ status: "assembling", canScan: true, filled: 0, total: 9, nextSlot: "CPU" });
    expect(view?.assembledBy).toBe("佐藤（バイト）");
    expect((await listInProgress()).map((u) => u.mgmtNo)).toContain(mgmtNo);
  });

  it("シリアルを読むと、構成表の枠に取り付けられ、部品は取付済みになる", async () => {
    const r = await scanPart(sato, mgmtNo, "9MP4C0501");
    expect(r).toMatchObject({ kind: "installed", slot: "CPU" });
    expect(await partStatus("9MP4C0501")).toBe("installed");
    const view = await getAssembly(mgmtNo);
    expect(view?.slots.find((s) => s.slot === "CPU")?.installed[0]).toMatchObject({
      serialNo: "9MP4C0501",
      by: "佐藤（バイト）",
    });
  });

  it("全角で入っても読める", async () => {
    const r = await scanPart(sato, mgmtNo, "ｂ５０７０－７８００１");
    expect(r).toMatchObject({ kind: "installed", slot: "GPU" });
  });

  it("構成表にない型番は止めて、使える型番を案内する", async () => {
    const r = await scanPart(sato, mgmtNo, "602-V520-0901");
    expect(r.kind).toBe("error");
    expect(r.message).toContain("構成表にありません");
    expect(r.message).toContain("RTX5070-A12G / RTX5070-B12G");
    expect(await partStatus("602-V520-0901")).toBe("in_stock");
  });

  it("もう付いている枠に、同じ種類の部品を読むと止める", async () => {
    // CPU枠は埋まっている。別のCPU（在庫）は無いので、取付済みのCPUを読んだ場合で確かめる
    const r = await scanPart(sato, mgmtNo, "9MP4C0501");
    expect(r).toMatchObject({ kind: "error" });
    expect(r.message).toContain(`もう ${mgmtNo} に取り付け済み`);
  });

  it("ほかの個体に付いている部品は使えない", async () => {
    const r = await scanPart(sato, mgmtNo, "PS85-2216");
    expect(r.kind).toBe("error");
    expect(r.message).toContain("ZB-2609-0118 に取り付け済み");
  });

  it("RMA中の部品は使えない", async () => {
    const r = await scanPart(sato, mgmtNo, "602-V531-3001");
    expect(r.message).toContain("RMA中");
  });

  it("登録されていないバーコードは止める", async () => {
    const r = await scanPart(sato, mgmtNo, "XYZ-NOT-FOUND");
    expect(r).toMatchObject({ kind: "error" });
    expect(r.message).toContain("登録されていません");
  });

  it("シリアルのある部品のJANを読んだら、シリアルを読むよう案内する", async () => {
    const r = await scanPart(sato, mgmtNo, "2000000000022");
    expect(r.message).toContain("シリアル番号のバーコードを読んでください");
  });

  it("シリアルのない部品（ケース）はJANで在庫から1つ選ぶ", async () => {
    const r = await scanPart(sato, mgmtNo, "2000000000015");
    expect(r).toMatchObject({ kind: "installed", slot: "CASE" });
  });

  it("間違えたら「1つ取り消す」で最後の部品を外し、在庫に戻せる", async () => {
    const before = (await getAssembly(mgmtNo))?.filled;
    const r = await undoLast(sato, mgmtNo);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("ケース");
    expect((await getAssembly(mgmtNo))?.filled).toBe((before ?? 0) - 1);
    // 取り消した記録は残る
    const [log] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.unit_parts up JOIN core.units u ON u.id = up.unit_id
        WHERE u.mgmt_no = $1 AND up.removed_at IS NOT NULL`,
      [mgmtNo],
    );
    expect(log.n).toBe(1);
  });

  it("部品が足りないうちは完了にできない", async () => {
    const r = await finishAssembly(sato, mgmtNo);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("まだ付いていない部品があります");
    expect(r.message).toContain("マザーボード");
  });

  it("全部の部品を読むと完了でき、検品待ちになる。そのあとは部品を読めない", async () => {
    for (const code of ["MB24-1101", "K5D-5101", "S6Z-9501", "PS85-2302", "LQ24-1501", "2000000000015", "KEY-AB1C"]) {
      const r = await scanPart(sato, mgmtNo, code);
      expect(r, code).toMatchObject({ kind: "installed" });
    }
    const view = await getAssembly(mgmtNo);
    expect(view).toMatchObject({ filled: 9, total: 9, nextSlot: null });

    const done = await finishAssembly(sato, mgmtNo);
    expect(done.ok).toBe(true);
    const after = await getAssembly(mgmtNo);
    expect(after).toMatchObject({ status: "inspecting", canScan: false });

    const r = await scanPart(sato, mgmtNo, "602-V520-0901");
    expect(r.message).toContain("組立中ではありません（今の状態：検品待ち）");
  });

  it("取り付けは「誰が」付きで監査ログに残る", async () => {
    const [row] = await query<{ installed_by: number }>(
      `SELECT up.installed_by FROM core.unit_parts up JOIN core.units u ON u.id = up.unit_id
        WHERE u.mgmt_no = $1 AND up.slot = 'CPU'`,
      [mgmtNo],
    );
    expect(row.installed_by).toBe(sato);
  });
});

describe("管理番号のシールを読んだとき", () => {
  it("別の個体の管理番号なら、その組立画面へ移る", async () => {
    const r = await scanPart(sato, mgmtNo, "zb-2610-0045");
    expect(r).toEqual({ kind: "unit", mgmtNo: "ZB-2610-0045", message: "ZB-2610-0045 の組立画面に移ります。" });
  });

  it("出荷済みの個体には部品を付けられない", async () => {
    const r = await scanPart(sato, "ZB-2609-0119", "602-V520-0901");
    expect(r.message).toContain("組立中ではありません（今の状態：FBA在庫）");
  });

  it("ない管理番号", async () => {
    expect(await getAssembly("ZB-9999-9999")).toBeNull();
    const r = await scanPart(sato, "ZB-9999-9999", "602-V520-0901");
    expect(r.message).toContain("という個体はありません");
  });
});
