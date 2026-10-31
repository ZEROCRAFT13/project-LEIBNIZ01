// 検品（3段階）の記録と写真（ダミーデータの DB に対して）
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUnit } from "@/lib/assembly";
import { listWorkerAccounts, setInspector } from "@/lib/auth/store";
import { getPool, query } from "@/lib/db";
import {
  addInspectionPhoto,
  getInspection,
  getInspectionSettings,
  getInspectionPhotoFile,
  listInspectionQueue,
  recordInspection,
  removeInspectionPhoto,
} from "@/lib/inspection";
import type { Stage } from "@/lib/inspection-calc";
import { fakeJpeg, makePdf } from "@/test/make-pdf";
import { loadFile } from "./storage";

let tmp: string;
let owner: number;
let sato: number;
let takahashi: number;
let unitBySato: string;
let unitByTakahashi: string;
let photoSeq = 0;

const userId = async (email: string) => (await query<{ id: number }>("SELECT id FROM core.users WHERE email = $1", [email]))[0].id;

/** 組立を完了したことにする（部品の取り付けは組立のテストで確かめているので、ここでは状態だけ） */
async function finishedAssembly(mgmtNo: string) {
  await query(`UPDATE core.units SET status = 'inspecting', assembled_at = now() WHERE mgmt_no = $1`, [mgmtNo]);
}

/** 全部 OK（「該当なし」にできる項目は該当なし） */
async function allOk(stage: Stage): Promise<string[]> {
  const { checklist } = await getInspectionSettings();
  return checklist[stage].map((i) => (i.na ? "na" : "ok"));
}

/** 写真ごとに中身を変える */
const photo = () => fakeJpeg(++photoSeq);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "zb-insp-"));
  process.env.ZB_STORAGE_DIR = join(tmp, "storage");
  owner = await userId("owner@zerobit.example");
  sato = await userId("sato@zerobit.example");
  takahashi = await userId("takahashi@zerobit.example");
  const [sku] = await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'");
  unitBySato = await startUnit(sato, sku.id);
  unitByTakahashi = await startUnit(takahashi, sku.id);
  await finishedAssembly(unitBySato);
  await finishedAssembly(unitByTakahashi);
});

afterAll(async () => {
  await getPool().end();
  await rm(tmp, { recursive: true, force: true });
});

describe("検品できる人", () => {
  it("検品を任せていないバイトはできない", async () => {
    const r = await recordInspection(sato, unitByTakahashi, "assembled", { result: "fail", note: "x", nextAction: "retry" });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("検品の役割がありません") });
  });

  it("検品を任せたバイトでも、自分で組んだ個体はできない", async () => {
    const r = await recordInspection(takahashi, unitByTakahashi, "assembled", { result: "fail", note: "x", nextAction: "retry" });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("組み立てた本人は検品できません") });
    const p = await addInspectionPhoto(takahashi, unitByTakahashi, "assembled", "wiring", photo());
    expect(p.ok).toBe(false);
  });

  it("「検品を任せる」を付け外しできる（バイトだけ）", async () => {
    expect((await listWorkerAccounts()).find((w) => w.id === takahashi)?.inspector).toBe(true);
    await setInspector(owner, sato, true);
    expect((await listWorkerAccounts()).find((w) => w.id === sato)?.inspector).toBe(true);
    await setInspector(owner, sato, true); // 二重に付けない
    const n = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.role_assignments WHERE user_id = $1 AND role_code = 'inspector' AND valid_to IS NULL`,
      [sato],
    );
    expect(n[0].n).toBe(1);
    await setInspector(owner, sato, false);
    expect((await listWorkerAccounts()).find((w) => w.id === sato)?.inspector).toBe(false);
    await expect(setInspector(owner, owner, true)).rejects.toThrow("バイトにだけ");
  });

  it("検品待ちの一覧に、組み立てた人と今の段階が出る", async () => {
    const q = await listInspectionQueue();
    expect(q.find((u) => u.mgmtNo === unitBySato)).toMatchObject({ assembledBy: "佐藤（バイト）", stage: "assembled" });
  });
});

describe("① 組立状態", () => {
  it("配線の写真がないと合格にできない", async () => {
    const r = await recordInspection(takahashi, unitBySato, "assembled", { result: "pass", checks: await allOk("assembled") });
    expect(r).toMatchObject({ ok: false, message: "合格にするには「配線の写真」が要ります。" });
  });

  it("写真でないもの・この段階で撮れない種類・ちがう段階は断る", async () => {
    const pdf = await makePdf(["x"]);
    expect(await addInspectionPhoto(takahashi, unitBySato, "assembled", "wiring", pdf)).toMatchObject({ ok: false });
    expect(await addInspectionPhoto(takahashi, unitBySato, "assembled", "boot", photo())).toMatchObject({
      ok: false,
      message: "この段階では撮れない種類の写真です。",
    });
    expect(await addInspectionPhoto(takahashi, unitBySato, "final", "boot", photo())).toMatchObject({ ok: false });
  });

  it("撮り間違えた写真は取り消せる", async () => {
    expect(await addInspectionPhoto(takahashi, unitBySato, "assembled", "other", photo())).toMatchObject({ ok: true });
    const v = await getInspection(unitBySato);
    expect(v?.pendingPhotos).toHaveLength(1);
    expect(await removeInspectionPhoto(takahashi, unitBySato, v!.pendingPhotos[0].id)).toMatchObject({ ok: true });
    expect((await getInspection(unitBySato))?.pendingPhotos).toHaveLength(0);
  });

  it("配線の写真を撮って、全部 OK なら合格。写真は記録にひもづき、取り消せなくなる", async () => {
    const bytes = photo();
    expect(await addInspectionPhoto(takahashi, unitBySato, "assembled", "wiring", bytes)).toMatchObject({
      ok: true,
      message: "配線の写真を残しました。",
    });
    const r = await recordInspection(takahashi, unitBySato, "assembled", { result: "pass", checks: await allOk("assembled") });
    expect(r).toMatchObject({ ok: true, done: false, message: "① 組立状態 に合格しました。" });

    const v = await getInspection(unitBySato);
    expect(v).toMatchObject({ status: "inspecting", stage: "software", passed: ["assembled"], pendingPhotos: [] });
    const rec = v!.records[0];
    expect(rec).toMatchObject({ stage: "assembled", result: "pass", inspector: "高橋（バイト）", current: true });
    expect(rec.photos).toHaveLength(1);
    expect(await removeInspectionPhoto(takahashi, unitBySato, rec.photos[0].id)).toMatchObject({ ok: false });

    // 保存したファイルは、撮った写真そのもの
    const file = await getInspectionPhotoFile(rec.photos[0].id);
    expect(file).toMatchObject({ mimeType: "image/jpeg", mgmtNo: unitBySato });
    expect(new Uint8Array(await loadFile(file!.storageUri))).toEqual(bytes);
  });

  it("合格した段階をもう一度は記録できない（画面が古いとき）", async () => {
    const r = await recordInspection(takahashi, unitBySato, "assembled", { result: "pass", checks: await allOk("assembled") });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("段階が変わりました") });
  });
});

describe("② Windows とベンチマーク", () => {
  it("不合格（やり直す）なら、同じ段階のまま", async () => {
    const r = await recordInspection(takahashi, unitBySato, "software", {
      result: "fail",
      note: "Windows の認証が通らない",
      nextAction: "retry",
    });
    expect(r).toMatchObject({ ok: true, done: false });
    expect(await getInspection(unitBySato)).toMatchObject({ status: "inspecting", stage: "software" });
    expect((await listInspectionQueue()).find((u) => u.mgmtNo === unitBySato)?.lastFail).toBe("Windows の認証が通らない");
  });

  it("上限を超えたら理由が要る。書けば合格になり、警告と理由が残る", async () => {
    const raw = {
      result: "pass",
      checks: await allOk("software"),
      stressTestMinutes: "120",
      maxCpuTempC: "91.5",
      maxGpuTempC: "70",
      noiseDb: "38",
      benchNames: ["Cinebench R23 マルチ"],
      benchScores: ["19100"],
    };
    const r1 = await recordInspection(takahashi, unitBySato, "software", raw);
    expect(r1).toMatchObject({ ok: false, errors: [expect.stringContaining("CPU 91.5℃（上限 90℃）")] });
    const r2 = await recordInspection(takahashi, unitBySato, "software", { ...raw, warningReason: "室温 32℃。許容内" });
    expect(r2).toMatchObject({ ok: true });
    const rec = (await getInspection(unitBySato))!.records[0];
    expect(rec).toMatchObject({
      stage: "software",
      stressTestMinutes: 120,
      maxCpuTempC: 91.5,
      warnings: ["CPU 91.5℃（上限 90℃）"],
      warningReason: "室温 32℃。許容内",
      benchmarks: [{ name: "Cinebench R23 マルチ", score: 19100 }],
    });
    // 作業時間が分かるように、前の記録の時刻から始まったことにする
    expect(rec.startedAt.getTime()).toBeLessThan(rec.finishedAt.getTime());
  });
});

describe("③ 最終確認と、組立に戻すとき", () => {
  it("不合格で「組立に戻す」と組立中になり、組立を完了すると①からやり直し", async () => {
    const r = await recordInspection(owner, unitBySato, "final", {
      result: "fail",
      checks: ["ng"],
      note: "天板に傷。ケースを交換する",
      nextAction: "rework",
    });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("組立に戻しました") });
    expect(await getInspection(unitBySato)).toMatchObject({ status: "assembling", stage: null });
    expect((await listInspectionQueue()).some((u) => u.mgmtNo === unitBySato)).toBe(false);

    await finishedAssembly(unitBySato);
    const v = await getInspection(unitBySato);
    expect(v).toMatchObject({ stage: "assembled", passed: [] });
    expect(v!.records.every((rec) => !rec.current)).toBe(true);
  });

  it("①〜③に合格すると、出荷できる状態になり、検品した人が残る", async () => {
    await addInspectionPhoto(owner, unitBySato, "assembled", "wiring", photo());
    expect(await recordInspection(owner, unitBySato, "assembled", { result: "pass", checks: await allOk("assembled") })).toMatchObject({ ok: true });
    expect(
      await recordInspection(owner, unitBySato, "software", {
        result: "pass",
        checks: await allOk("software"),
        stressTestMinutes: "60",
        maxCpuTempC: "80",
      }),
    ).toMatchObject({ ok: true });
    const noPhoto = await recordInspection(owner, unitBySato, "final", { result: "pass", checks: await allOk("final") });
    expect(noPhoto).toMatchObject({ ok: false, message: "合格にするには「正常に起動している写真」が要ります。" });
    await addInspectionPhoto(owner, unitBySato, "final", "boot", photo());
    const r = await recordInspection(owner, unitBySato, "final", { result: "pass", checks: await allOk("final") });
    expect(r).toMatchObject({ ok: true, done: true, message: `${unitBySato} の検品がすべて終わりました。出荷できます。` });

    const [u] = await query<{ status: string; inspected_by: number; inspected_at: Date | null }>(
      "SELECT status, inspected_by, inspected_at FROM core.units WHERE mgmt_no = $1",
      [unitBySato],
    );
    expect(u).toMatchObject({ status: "ready", inspected_by: owner });
    expect(u.inspected_at).toBeInstanceOf(Date);
    expect(await getInspection(unitBySato)).toMatchObject({ status: "ready", stage: null, passed: ["assembled", "software", "final"] });
    expect(await recordInspection(owner, unitBySato, "final", { result: "pass" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("検品中ではありません"),
    });
  });
});
