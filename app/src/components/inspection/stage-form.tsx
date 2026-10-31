"use client";

import { useActionState, useState } from "react";
import { recordAction, type InspectState } from "@/app/inspection/actions";
import {
  MAX_BENCHMARKS,
  computeWarnings,
  stageLabel,
  type CheckValue,
  type ChecklistItem,
  type Limits,
  type Stage,
} from "@/lib/inspection-calc";

// 段階の記録のフォーム。答えはすべて state に持つ（送信のあと React がフォームを空にしても消えないように）。
// 記録できたら、画面の再読み込みで formKey が変わり、入力欄（StageFields）が作り直されて空になる。
export function StageForm(props: {
  mgmtNo: string;
  stage: Stage;
  items: ChecklistItem[];
  limits: Limits;
  formKey: string;
  photoMissing: string | null;
}) {
  const [state, action, pending] = useActionState<InspectState, FormData>(recordAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="mgmtNo" value={props.mgmtNo} />
      <input type="hidden" name="stage" value={props.stage} />
      {state && (
        <div
          role={state.ok ? "status" : "alert"}
          className={`rounded-md px-4 py-3 text-sm ${state.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
        >
          <p className="font-bold">{state.message}</p>
          {state.errors && (
            <ul className="mt-1 list-disc pl-5">
              {state.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <StageFields key={props.formKey} {...props} pending={pending} />
    </form>
  );
}

function StageFields({
  stage,
  items,
  limits,
  photoMissing,
  pending,
}: {
  stage: Stage;
  items: ChecklistItem[];
  limits: Limits;
  photoMissing: string | null;
  pending: boolean;
}) {
  const [checks, setChecks] = useState<(CheckValue | "")[]>(() => items.map(() => ""));
  const [m, setM] = useState({ stressTestMinutes: "", maxCpuTempC: "", maxGpuTempC: "", noiseDb: "" });
  const [bench, setBench] = useState([
    { name: "", score: "" },
    { name: "", score: "" },
  ]);
  const [result, setResult] = useState<"" | "pass" | "fail">("");
  const [note, setNote] = useState("");
  const [nextAction, setNextAction] = useState<"" | "retry" | "rework">("");
  const [warningReason, setWarningReason] = useState("");

  // 画面の上での目安（正式な判定はサーバーがもう一度計算する）
  const asNum = (v: string) => {
    const t = v.normalize("NFKC").replace(/[,\s]/g, "").replace(/(°C|℃|dB|分)$/i, "");
    return t === "" || !Number.isFinite(Number(t)) ? null : Number(t);
  };
  const warnings =
    stage === "software"
      ? computeWarnings(
          {
            stressTestMinutes: asNum(m.stressTestMinutes),
            maxCpuTempC: asNum(m.maxCpuTempC),
            maxGpuTempC: asNum(m.maxGpuTempC),
            noiseDb: asNum(m.noiseDb),
          },
          limits,
        )
      : [];
  const answered = checks.filter((c) => c !== "").length;
  const ng = checks.filter((c) => c === "ng").length;

  return (
    <>
      <section aria-labelledby="checks-title" className="flex flex-col gap-2 rounded-lg border border-stone-300 bg-white p-4">
        <h2 id="checks-title" className="flex items-baseline justify-between gap-2 font-bold">
          チェック項目
          <span className="text-sm font-medium text-stone-600">
            {answered} / {items.length}
            {ng > 0 && <span className="ml-2 text-red-800">NG {ng}</span>}
          </span>
        </h2>
        <ol className="flex flex-col">
          {items.map((item, i) => (
            <li key={item.label} className="flex flex-col gap-2 border-b border-stone-100 py-3 last:border-0 sm:flex-row sm:items-center">
              <span className="flex-1 text-sm">
                <span className="mr-1 font-mono text-stone-500">{i + 1}.</span>
                {item.label}
              </span>
              <fieldset className="flex gap-1">
                <legend className="sr-only">{item.label}</legend>
                {(["ok", ...(item.na ? ["na"] : []), "ng"] as CheckValue[]).map((v) => (
                  <label
                    key={v}
                    className={`flex h-10 min-w-16 cursor-pointer items-center justify-center rounded-md border px-3 text-sm font-bold ${
                      checks[i] === v
                        ? v === "ok"
                          ? "border-green-700 bg-green-700 text-white"
                          : v === "ng"
                            ? "border-red-700 bg-red-700 text-white"
                            : "border-stone-600 bg-stone-600 text-white"
                        : "border-stone-300 text-stone-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`c${i}`}
                      value={v}
                      checked={checks[i] === v}
                      onChange={() => setChecks((c) => c.map((x, j) => (j === i ? v : x)))}
                      className="sr-only"
                    />
                    {v === "ok" ? "OK" : v === "ng" ? "NG" : "該当なし"}
                  </label>
                ))}
              </fieldset>
            </li>
          ))}
        </ol>
      </section>

      {stage === "software" && (
        <section aria-labelledby="measure-title" className="flex flex-col gap-3 rounded-lg border border-stone-300 bg-white p-4">
          <h2 id="measure-title" className="font-bold">
            負荷試験
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["stressTestMinutes", "時間（分）", `${limits.minStressTestMinutes}分以上`, "numeric"],
                ["maxCpuTempC", "CPU 最高温度（℃）", `上限 ${limits.maxCpuTempC}℃`, "decimal"],
                ["maxGpuTempC", "GPU 最高温度（℃）", `上限 ${limits.maxGpuTempC}℃・GPU なしは空`, "decimal"],
                ["noiseDb", "騒音（dB）", `上限 ${limits.maxNoiseDb}dB・任意`, "decimal"],
              ] as const
            ).map(([key, text, hint, mode]) => (
              <label key={key} className="flex flex-col gap-1 text-sm font-medium">
                {text}
                <input
                  name={key}
                  inputMode={mode}
                  autoComplete="off"
                  value={m[key]}
                  onChange={(e) => {
                    const v = e.target.value;
                    setM((s) => ({ ...s, [key]: v }));
                  }}
                  className="h-11 rounded-md border border-stone-400 bg-white px-3 font-mono"
                />
                <span className="text-xs font-normal text-stone-500">{hint}</span>
              </label>
            ))}
          </div>

          <h3 className="mt-2 font-bold">ベンチマーク</h3>
          <div className="flex flex-col gap-2">
            {bench.map((b, i) => (
              <div key={i} className="flex gap-2">
                <input
                  name="benchName"
                  aria-label={`ベンチマーク ${i + 1} の名前`}
                  placeholder={i === 0 ? "Cinebench R23 マルチ" : i === 1 ? "3DMark Time Spy" : "名前"}
                  value={b.name}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBench((s) => s.map((x, j) => (j === i ? { ...x, name: v } : x)));
                  }}
                  className="h-11 min-w-0 flex-1 rounded-md border border-stone-400 bg-white px-3 text-sm"
                />
                <input
                  name="benchScore"
                  aria-label={`ベンチマーク ${i + 1} の点数`}
                  inputMode="decimal"
                  placeholder="点数"
                  value={b.score}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBench((s) => s.map((x, j) => (j === i ? { ...x, score: v } : x)));
                  }}
                  className="h-11 w-28 rounded-md border border-stone-400 bg-white px-3 font-mono text-sm"
                />
              </div>
            ))}
            {bench.length < MAX_BENCHMARKS && (
              <button
                type="button"
                onClick={() => setBench((s) => [...s, { name: "", score: "" }])}
                className="w-fit text-sm text-blue-800 underline"
              >
                行を足す
              </button>
            )}
          </div>
          {warnings.length > 0 && (
            <p role="alert" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-950">
              上限を超えています：{warnings.join("、")}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="result-title" className="flex flex-col gap-3 rounded-lg border border-stone-300 bg-white p-4">
        <h2 id="result-title" className="font-bold">
          結果
        </h2>
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="sr-only">合格か不合格か</legend>
          {(["pass", "fail"] as const).map((v) => (
            <label
              key={v}
              className={`flex h-12 cursor-pointer items-center justify-center rounded-md border text-base font-bold ${
                result === v
                  ? v === "pass"
                    ? "border-green-700 bg-green-700 text-white"
                    : "border-red-700 bg-red-700 text-white"
                  : "border-stone-300 text-stone-700"
              }`}
            >
              <input
                type="radio"
                name="result"
                value={v}
                checked={result === v}
                onChange={() => setResult(v)}
                className="sr-only"
              />
              {v === "pass" ? "合格" : "不合格"}
            </label>
          ))}
        </fieldset>

        {result === "pass" && warnings.length > 0 && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            上限を超えても合格にする理由
            <input
              name="warningReason"
              value={warningReason}
              onChange={(e) => setWarningReason(e.target.value)}
              maxLength={200}
              placeholder="例：室温 32℃。部品メーカーの許容範囲内"
              className="h-11 rounded-md border border-stone-400 bg-white px-3"
            />
          </label>
        )}

        {result === "fail" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">このあと</legend>
            {(
              [
                ["retry", "この段階をやり直す", "設定やソフトを直して、もう一度この段階を検品する"],
                ["rework", "組立に戻す", "部品を替える・付け直す。組立を完了したら、検品は①からやり直し"],
              ] as const
            ).map(([v, text, hint]) => (
              <label
                key={v}
                className={`flex cursor-pointer flex-col rounded-md border px-3 py-2 ${
                  nextAction === v ? "border-blue-700 bg-blue-50" : "border-stone-300"
                }`}
              >
                <span className="flex items-center gap-2 font-bold">
                  <input type="radio" name="nextAction" value={v} checked={nextAction === v} onChange={() => setNextAction(v)} />
                  {text}
                </span>
                <span className="pl-6 text-xs text-stone-600">{hint}</span>
              </label>
            ))}
          </fieldset>
        )}

        <label className="flex flex-col gap-1 text-sm font-medium">
          {result === "fail" ? "不合格の理由（必須）" : "メモ（任意）"}
          <textarea
            name="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder={result === "fail" ? "例：GPU の補助電源が半刺し" : ""}
            className="rounded-md border border-stone-400 bg-white px-3 py-2"
          />
          <span className="text-xs font-normal text-stone-500">お客様の名前・住所などは書かないでください。</span>
        </label>

        {result === "pass" && photoMissing && (
          <p className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-950">合格にするには、上で「{photoMissing}」を撮ってください。</p>
        )}

        <button
          type="submit"
          disabled={pending || result === ""}
          className={`h-14 rounded-md text-lg font-bold text-white disabled:opacity-50 ${
            result === "fail" ? "bg-red-700" : "bg-blue-800"
          }`}
        >
          {pending
            ? "記録しています…"
            : result === "fail"
              ? `${stageLabel[stage]} を不合格として記録する`
              : `${stageLabel[stage]} を合格にする`}
        </button>
      </section>
    </>
  );
}
