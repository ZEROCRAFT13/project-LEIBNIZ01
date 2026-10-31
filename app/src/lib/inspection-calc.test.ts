// 検品の入力の確かめと、上限の判定（DBを使わない）
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  computeWarnings,
  nextStage,
  parseChecklist,
  parseInspectionInput,
  parseLimits,
  type ChecklistItem,
} from "@/lib/inspection-calc";

const items: ChecklistItem[] = [
  { label: "BIOS の更新", na: false },
  { label: "Wi-Fi・Bluetooth", na: true },
];
const limits = DEFAULT_LIMITS; // CPU 90 / GPU 85 / 騒音 45 / 負荷試験 60分以上

describe("段階の順番", () => {
  it("合格した段階から、次の段階を決める", () => {
    expect(nextStage([])).toBe("assembled");
    expect(nextStage(["assembled"])).toBe("software");
    expect(nextStage(["software", "assembled"])).toBe("final");
    expect(nextStage(["assembled", "software", "final"])).toBeNull();
    // ①をとばして②だけ合格、は起きないが、起きても①から
    expect(nextStage(["software"])).toBe("assembled");
  });
});

describe("設定の読み込み", () => {
  it("上限はおかしな値を初期値にする", () => {
    expect(parseLimits({ maxCpuTempC: 95, maxGpuTempC: "x", maxNoiseDb: -1 })).toEqual({
      ...DEFAULT_LIMITS,
      maxCpuTempC: 95,
    });
    expect(parseLimits(null)).toEqual(DEFAULT_LIMITS);
  });

  it("チェック項目は名前のあるものだけ。na: true で「該当なし」を選べる", () => {
    const c = parseChecklist({ assembled: [{ label: " 配線 " }, { label: "" }, { x: 1 }], software: [{ label: "Wi-Fi", na: true }] });
    expect(c).toEqual({ assembled: [{ label: "配線", na: false }], software: [{ label: "Wi-Fi", na: true }], final: [] });
  });
});

describe("上限を超えたかの判定", () => {
  it("上限ちょうどは警告しない。超えたら項目ごとに出す", () => {
    expect(computeWarnings({ stressTestMinutes: 60, maxCpuTempC: 90, maxGpuTempC: 85, noiseDb: 45 }, limits)).toEqual([]);
    expect(computeWarnings({ stressTestMinutes: 30, maxCpuTempC: 90.5, maxGpuTempC: 86, noiseDb: 45.1 }, limits)).toEqual([
      "負荷試験 30分（60分以上）",
      "CPU 90.5℃（上限 90℃）",
      "GPU 86.0℃（上限 85℃）",
      "騒音 45.1dB（上限 45dB）",
    ]);
  });

  it("入れていない値は判定しない（GPU を積まない機種など）", () => {
    expect(computeWarnings({ stressTestMinutes: null, maxCpuTempC: null, maxGpuTempC: null, noiseDb: null }, limits)).toEqual([]);
  });
});

describe("①・③の入力", () => {
  it("全部 OK（または該当なし）なら合格にできる", () => {
    const r = parseInspectionInput("final", items, limits, { result: "pass", checks: ["ok", "na"] });
    expect(r).toEqual({
      ok: true,
      value: expect.objectContaining({
        result: "pass",
        checklist: { "BIOS の更新": true, "Wi-Fi・Bluetooth": "na" },
        warnings: [],
        nextAction: null,
      }),
    });
  });

  it("確かめていない項目や NG があると合格にできない", () => {
    const r1 = parseInspectionInput("final", items, limits, { result: "pass", checks: ["ok"] });
    expect(r1.ok ? [] : r1.errors.join()).toContain("まだ確かめていない項目があります：Wi-Fi・Bluetooth");
    const r2 = parseInspectionInput("final", items, limits, { result: "pass", checks: ["ng", "ok"] });
    expect(r2.ok ? [] : r2.errors.join()).toContain("NG の項目があるので合格にできません：BIOS の更新");
  });

  it("「該当なし」にできない項目は止める", () => {
    const r = parseInspectionInput("final", items, limits, { result: "pass", checks: ["na", "ok"] });
    expect(r.ok ? [] : r.errors.join()).toContain("「BIOS の更新」は「該当なし」にできません");
  });

  it("不合格には理由と次の手が要る。途中までのチェックでもよい", () => {
    const r1 = parseInspectionInput("assembled", items, limits, { result: "fail", checks: ["ng"] });
    expect(r1.ok ? [] : r1.errors).toEqual([
      "不合格の理由を書いてください。",
      "不合格のあとどうするか（この段階をやり直す／組立に戻す）を選んでください。",
    ]);
    const r2 = parseInspectionInput("assembled", items, limits, {
      result: "fail",
      checks: ["ng"],
      note: " GPU の補助電源が半刺し ",
      nextAction: "rework",
    });
    expect(r2).toEqual({
      ok: true,
      value: expect.objectContaining({
        checklist: { "BIOS の更新": false },
        note: "GPU の補助電源が半刺し",
        nextAction: "rework",
      }),
    });
  });

  it("合否を選んでいなければ止める", () => {
    expect(parseInspectionInput("final", items, limits, { checks: ["ok", "ok"] }).ok).toBe(false);
  });

  it("①・③では温度やベンチマークを入れても使わない", () => {
    const r = parseInspectionInput("final", items, limits, {
      result: "pass",
      checks: ["ok", "ok"],
      maxCpuTempC: "99",
      benchNames: ["x"],
      benchScores: ["1"],
    });
    expect(r.ok && r.value.measurements.maxCpuTempC).toBeNull();
    expect(r.ok && r.value.benchmarks).toEqual([]);
  });
});

describe("②の入力（負荷試験とベンチマーク）", () => {
  const base = { result: "pass", checks: ["ok", "na"] };

  it("全角・単位つきでも読む", () => {
    const r = parseInspectionInput("software", items, limits, {
      ...base,
      stressTestMinutes: "１２０分",
      maxCpuTempC: "７８.５℃",
      maxGpuTempC: "70",
      noiseDb: "37.0dB",
      benchNames: ["Cinebench R23", "", "3DMark Time Spy"],
      benchScores: ["19,100", "", "17400"],
    });
    expect(r).toEqual({
      ok: true,
      value: expect.objectContaining({
        measurements: { stressTestMinutes: 120, maxCpuTempC: 78.5, maxGpuTempC: 70, noiseDb: 37 },
        benchmarks: [
          { name: "Cinebench R23", score: 19100 },
          { name: "3DMark Time Spy", score: 17400 },
        ],
        warnings: [],
      }),
    });
  });

  it("合格には負荷試験の時間と CPU 温度が要る（GPU・騒音は任意）", () => {
    const r = parseInspectionInput("software", items, limits, { ...base });
    expect(r.ok ? [] : r.errors).toEqual(["合格にするには、負荷試験の時間が要ります。", "合格にするには、CPU の最高温度が要ります。"]);
    expect(parseInspectionInput("software", items, limits, { ...base, stressTestMinutes: "60", maxCpuTempC: "80" }).ok).toBe(true);
  });

  it("おかしな数字は止める", () => {
    const r = parseInspectionInput("software", items, limits, {
      ...base,
      stressTestMinutes: "1.5",
      maxCpuTempC: "200",
      maxGpuTempC: "7.25",
      noiseDb: "abc",
    });
    expect(r.ok ? [] : r.errors).toEqual([
      "負荷試験の時間は 0〜1440 の整数（分）で入れてください。",
      "CPU の最高温度は 0〜150 の数字（小数1けたまで）で入れてください。",
      "GPU の最高温度は 0〜150 の数字（小数1けたまで）で入れてください。",
      "騒音は 0〜120 の数字（小数1けたまで）で入れてください。",
    ]);
  });

  it("上限を超えたら、理由を書けば合格にできる（警告は残る）", () => {
    const over = { ...base, stressTestMinutes: "60", maxCpuTempC: "92" };
    const r1 = parseInspectionInput("software", items, limits, over);
    expect(r1.ok ? [] : r1.errors).toEqual(["上限を超えています（CPU 92.0℃（上限 90℃））。合格にするなら理由を書いてください。"]);
    const r2 = parseInspectionInput("software", items, limits, { ...over, warningReason: "室温 32℃。メーカーの許容内" });
    expect(r2).toEqual({
      ok: true,
      value: expect.objectContaining({ warnings: ["CPU 92.0℃（上限 90℃）"], warningReason: "室温 32℃。メーカーの許容内" }),
    });
  });

  it("不合格のときも、上限を超えた記録は残す（理由は要らない）", () => {
    const r = parseInspectionInput("software", items, limits, {
      result: "fail",
      maxCpuTempC: "98",
      note: "CPU が熱い。グリスを塗り直す",
      nextAction: "rework",
      warningReason: "使わない",
    });
    expect(r).toEqual({
      ok: true,
      value: expect.objectContaining({ warnings: ["CPU 98.0℃（上限 90℃）"], warningReason: null }),
    });
  });

  it("ベンチマークは名前と点数の両方が要る", () => {
    const r = parseInspectionInput("software", items, limits, {
      ...base,
      stressTestMinutes: "60",
      maxCpuTempC: "80",
      benchNames: ["Cinebench", ""],
      benchScores: ["", "100"],
    });
    expect(r.ok ? [] : r.errors).toEqual(["「Cinebench」の点数を数字で入れてください。", "ベンチマーク 2 の名前を入れてください。"]);
  });
});
