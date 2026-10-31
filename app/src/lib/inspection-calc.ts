// 検品（3段階）の入力の確かめと、上限を超えたかの判定。DBを使わないので、そのままテストできる。
// 温度・時間の比較はここ（プログラム）で行い、AI には判定させない（ルール5）。

export const STAGES = ["assembled", "software", "final"] as const;
export type Stage = (typeof STAGES)[number];

export const stageLabel: Record<Stage, string> = {
  assembled: "① 組立状態",
  software: "② Windows とベンチマーク",
  final: "③ 出荷直前の最終確認",
};

export type PhotoKind = "wiring" | "benchmark" | "boot" | "other";

export const photoKindLabel: Record<PhotoKind, string> = {
  wiring: "配線の写真",
  benchmark: "ベンチマークの結果",
  boot: "正常に起動している写真",
  other: "その他の写真",
};

/** 段階ごとに撮れる写真の種類（先頭がその段階の主な写真） */
export const PHOTO_KINDS: Record<Stage, PhotoKind[]> = {
  assembled: ["wiring", "other"],
  software: ["benchmark", "other"],
  final: ["boot", "other"],
};

/** 合格に必要な写真（②は任意） */
export const REQUIRED_PHOTO: Record<Stage, PhotoKind | null> = {
  assembled: "wiring",
  software: null,
  final: "boot",
};

/** 写真の撮り方の案内 */
export const photoHint: Record<PhotoKind, string> = {
  wiring: "側面パネルを外した状態で、配線全体が分かるように。管理番号のシールも一緒に写るとよい",
  benchmark: "ベンチマークや負荷試験の結果の画面",
  boot: "Windows が起動した画面と、本体の管理番号シールが一緒に写るように（どの個体か後で分かるように）",
  other: "気になった点など",
};

export const MAX_PHOTOS_PER_STAGE = 10;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const MAX_BENCHMARKS = 6;

export type Limits = {
  maxCpuTempC: number;
  maxGpuTempC: number;
  maxNoiseDb: number;
  minStressTestMinutes: number;
};

export const DEFAULT_LIMITS: Limits = { maxCpuTempC: 90, maxGpuTempC: 85, maxNoiseDb: 45, minStressTestMinutes: 60 };

export type ChecklistItem = { label: string; na: boolean };
export type Checklist = Record<Stage, ChecklistItem[]>;

/** core.settings の値（JSON）を読む。おかしな値は初期値にする */
export function parseLimits(raw: unknown): Limits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof Limits) => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_LIMITS[k];
  };
  return {
    maxCpuTempC: pick("maxCpuTempC"),
    maxGpuTempC: pick("maxGpuTempC"),
    maxNoiseDb: pick("maxNoiseDb"),
    minStressTestMinutes: pick("minStressTestMinutes"),
  };
}

export function parseChecklist(raw: unknown): Checklist {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items = (v: unknown): ChecklistItem[] =>
    Array.isArray(v)
      ? v
          .filter((i): i is { label: string; na?: unknown } => !!i && typeof i === "object" && typeof i.label === "string")
          .map((i) => ({ label: i.label.trim(), na: i.na === true }))
          .filter((i) => i.label.length > 0)
      : [];
  return { assembled: items(r.assembled), software: items(r.software), final: items(r.final) };
}

/** 今の回（最後に組立を完了してから）に合格した段階から、次に検品する段階を決める。全部合格なら null */
export function nextStage(passed: Iterable<Stage>): Stage | null {
  const done = new Set(passed);
  return STAGES.find((s) => !done.has(s)) ?? null;
}

export type Measurements = {
  stressTestMinutes: number | null;
  maxCpuTempC: number | null;
  maxGpuTempC: number | null;
  noiseDb: number | null;
};

/** 上限を超えた項目（超えたら警告。合格にするには理由が要る） */
export function computeWarnings(m: Measurements, limits: Limits): string[] {
  const w: string[] = [];
  if (m.stressTestMinutes !== null && m.stressTestMinutes < limits.minStressTestMinutes) {
    w.push(`負荷試験 ${m.stressTestMinutes}分（${limits.minStressTestMinutes}分以上）`);
  }
  if (m.maxCpuTempC !== null && m.maxCpuTempC > limits.maxCpuTempC) {
    w.push(`CPU ${m.maxCpuTempC.toFixed(1)}℃（上限 ${limits.maxCpuTempC}℃）`);
  }
  if (m.maxGpuTempC !== null && m.maxGpuTempC > limits.maxGpuTempC) {
    w.push(`GPU ${m.maxGpuTempC.toFixed(1)}℃（上限 ${limits.maxGpuTempC}℃）`);
  }
  if (m.noiseDb !== null && m.noiseDb > limits.maxNoiseDb) {
    w.push(`騒音 ${m.noiseDb.toFixed(1)}dB（上限 ${limits.maxNoiseDb}dB）`);
  }
  return w;
}

export type CheckValue = "ok" | "na" | "ng";
export type Benchmark = { name: string; score: number };

export type InspectionRaw = {
  result?: string;
  /** チェック項目の答え（項目の順番どおり。ok / na / ng / 空） */
  checks?: string[];
  stressTestMinutes?: string;
  maxCpuTempC?: string;
  maxGpuTempC?: string;
  noiseDb?: string;
  benchNames?: string[];
  benchScores?: string[];
  warningReason?: string;
  note?: string;
  nextAction?: string;
};

export type InspectionInput = {
  result: "pass" | "fail";
  /** 保存する形：{ 項目名: true（OK） | "na"（該当なし） | false（NG） }。答えていない項目は入れない */
  checklist: Record<string, true | false | "na">;
  measurements: Measurements;
  benchmarks: Benchmark[];
  warnings: string[];
  warningReason: string | null;
  note: string | null;
  nextAction: "retry" | "rework" | null;
};

export type InspectionParsed = { ok: true; value: InspectionInput } | { ok: false; errors: string[] };

/** 数字の欄（全角でも読む）。空なら null、おかしければ undefined */
function num(raw: string | undefined, { max, decimals }: { max: number; decimals: number }): number | null | undefined {
  const t = (raw ?? "").normalize("NFKC").replace(/[,\s]/g, "").replace(/(°C|℃|度|dB|分)$/i, "") // NFKC で ℃ は °C になる;
  if (t === "") return null;
  const re = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!re.test(t)) return undefined;
  const v = Number(t);
  return v >= 0 && v <= max ? v : undefined;
}

function text(raw: string | undefined, max: number): string | null | undefined {
  const t = (raw ?? "").normalize("NFC").trim();
  if (t === "") return null;
  return t.length <= max ? t : undefined;
}

/** 段階の記録の入力を確かめる（合格の条件もここで見る。最後の砦は DB の決まり） */
export function parseInspectionInput(
  stage: Stage,
  items: ChecklistItem[],
  limits: Limits,
  raw: InspectionRaw,
): InspectionParsed {
  const errors: string[] = [];
  const result = raw.result === "pass" || raw.result === "fail" ? raw.result : null;
  if (!result) errors.push("合格か不合格かを選んでください。");

  // チェック項目
  const checklist: InspectionInput["checklist"] = {};
  const unanswered: string[] = [];
  const ng: string[] = [];
  items.forEach((item, i) => {
    const v = raw.checks?.[i] ?? "";
    if (v === "ok") checklist[item.label] = true;
    else if (v === "ng") {
      checklist[item.label] = false;
      ng.push(item.label);
    } else if (v === "na") {
      if (item.na) checklist[item.label] = "na";
      else errors.push(`「${item.label}」は「該当なし」にできません。`);
    } else unanswered.push(item.label);
  });
  if (result === "pass") {
    if (unanswered.length > 0) errors.push(`まだ確かめていない項目があります：${unanswered.join("、")}`);
    if (ng.length > 0) errors.push(`NG の項目があるので合格にできません：${ng.join("、")}`);
  }

  // 負荷試験とベンチマーク（②だけ）
  let measurements: Measurements = { stressTestMinutes: null, maxCpuTempC: null, maxGpuTempC: null, noiseDb: null };
  const benchmarks: Benchmark[] = [];
  if (stage === "software") {
    const minutes = num(raw.stressTestMinutes, { max: 1440, decimals: 0 });
    const cpu = num(raw.maxCpuTempC, { max: 150, decimals: 1 });
    const gpu = num(raw.maxGpuTempC, { max: 150, decimals: 1 });
    const noise = num(raw.noiseDb, { max: 120, decimals: 1 });
    if (minutes === undefined) errors.push("負荷試験の時間は 0〜1440 の整数（分）で入れてください。");
    if (cpu === undefined) errors.push("CPU の最高温度は 0〜150 の数字（小数1けたまで）で入れてください。");
    if (gpu === undefined) errors.push("GPU の最高温度は 0〜150 の数字（小数1けたまで）で入れてください。");
    if (noise === undefined) errors.push("騒音は 0〜120 の数字（小数1けたまで）で入れてください。");
    measurements = {
      stressTestMinutes: minutes ?? null,
      maxCpuTempC: cpu ?? null,
      maxGpuTempC: gpu ?? null,
      noiseDb: noise ?? null,
    };
    if (result === "pass") {
      if (minutes === null) errors.push("合格にするには、負荷試験の時間が要ります。");
      if (cpu === null) errors.push("合格にするには、CPU の最高温度が要ります。");
    }

    const names = raw.benchNames ?? [];
    const scores = raw.benchScores ?? [];
    for (let i = 0; i < Math.max(names.length, scores.length); i++) {
      const name = text(names[i], 40);
      const score = num(scores[i], { max: 10_000_000, decimals: 2 });
      if (name === null && score === null) continue;
      if (name === undefined) errors.push(`ベンチマーク ${i + 1} の名前は40文字までにしてください。`);
      else if (name === null) errors.push(`ベンチマーク ${i + 1} の名前を入れてください。`);
      else if (score === null || score === undefined) errors.push(`「${name}」の点数を数字で入れてください。`);
      else benchmarks.push({ name, score });
    }
    if (benchmarks.length > MAX_BENCHMARKS) errors.push(`ベンチマークは ${MAX_BENCHMARKS} 件までです。`);
  }

  const warnings = computeWarnings(measurements, limits);
  const warningReason = text(raw.warningReason, 200);
  const note = text(raw.note, 500);
  if (warningReason === undefined) errors.push("上限を超えても合格にする理由は200文字までにしてください。");
  if (note === undefined) errors.push("メモは500文字までにしてください。");
  if (result === "pass" && warnings.length > 0 && !warningReason) {
    errors.push(`上限を超えています（${warnings.join("、")}）。合格にするなら理由を書いてください。`);
  }

  const nextAction = raw.nextAction === "retry" || raw.nextAction === "rework" ? raw.nextAction : null;
  if (result === "fail") {
    if (!note) errors.push("不合格の理由を書いてください。");
    if (!nextAction) errors.push("不合格のあとどうするか（この段階をやり直す／組立に戻す）を選んでください。");
  }

  if (errors.length > 0 || !result) return { ok: false, errors };
  return {
    ok: true,
    value: {
      result,
      checklist,
      measurements,
      benchmarks,
      warnings,
      warningReason: result === "pass" && warnings.length > 0 ? (warningReason ?? null) : null,
      note: note ?? null,
      nextAction: result === "fail" ? nextAction : null,
    },
  };
}
