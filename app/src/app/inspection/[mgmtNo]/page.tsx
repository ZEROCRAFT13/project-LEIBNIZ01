import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PhotoPanel } from "@/components/inspection/photo-panel";
import { StageForm } from "@/components/inspection/stage-form";
import { Loading, Tag } from "@/components/ui";
import { requireInspector } from "@/lib/auth/session";
import { ymdHm } from "@/lib/format";
import { getInspection, getInspectionSettings, type InspectionRecord } from "@/lib/inspection";
import { REQUIRED_PHOTO, STAGES, photoKindLabel, stageLabel } from "@/lib/inspection-calc";
import { label, unitStatusLabel } from "@/lib/labels";

export const metadata: Metadata = { title: "検品 | ZERO-BIT" };

export default function InspectionUnitPage({ params }: PageProps<"/inspection/[mgmtNo]">) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-5">
      <Link href="/inspection" className="text-sm text-blue-800 hover:underline">
        ← 検品のトップ
      </Link>
      <Suspense fallback={<Loading />}>
        <InspectionUnit params={params} />
      </Suspense>
    </main>
  );
}

async function InspectionUnit({ params }: { params: PageProps<"/inspection/[mgmtNo]">["params"] }) {
  const { mgmtNo } = await params;
  const viewer = await requireInspector(`/inspection/${mgmtNo}`);
  const [view, settings] = await Promise.all([getInspection(decodeURIComponent(mgmtNo)), getInspectionSettings()]);
  if (!view) notFound();

  const own = view.assembledBy?.id === viewer.user.id;
  const current = view.records.filter((r) => r.current);
  const older = view.records.filter((r) => !r.current);
  const required = view.stage ? REQUIRED_PHOTO[view.stage] : null;
  const photoMissing =
    required && !view.pendingPhotos.some((p) => p.kind === required) ? photoKindLabel[required] : null;

  return (
    <>
      <header className="flex flex-col gap-2 rounded-lg bg-stone-900 px-4 py-4 text-white">
        <div className="flex justify-between gap-2 text-xs text-stone-300">
          <span>{label(unitStatusLabel, view.status)}</span>
          <span>{viewer.user.name} さんが検品</span>
        </div>
        <p className="font-mono text-3xl font-medium tracking-wide">{view.mgmtNo}</p>
        <p className="text-sm text-stone-300">
          <span className="font-mono">{view.sku.code}</span>　{view.sku.name}
        </p>
        <p className="text-sm text-stone-300">
          組立 {view.assembledBy?.name ?? "—"}・{ymdHm(view.assembledAt)}
        </p>
        <ol aria-label="検品の段階" className="mt-1 grid grid-cols-3 gap-1">
          {STAGES.map((s) => {
            const done = view.passed.includes(s);
            const now = view.stage === s;
            return (
              <li
                key={s}
                aria-current={now ? "step" : undefined}
                className={`rounded px-2 py-1.5 text-center text-xs font-bold ${
                  done ? "bg-green-600 text-white" : now ? "bg-white text-stone-900" : "bg-stone-700 text-stone-300"
                }`}
              >
                {done ? "✓ " : ""}
                {stageLabel[s]}
              </li>
            );
          })}
        </ol>
      </header>

      {view.status === "ready" || (view.stage === null && view.passed.length === STAGES.length) ? (
        <div role="status" className="flex flex-col gap-2 rounded-md bg-green-100 px-4 py-4 text-green-950">
          <p className="text-lg font-bold">✓ 検品がすべて終わりました。出荷できます。</p>
          <p className="text-sm">検品完了 {ymdHm(view.inspectedAt)}</p>
          <Link href="/inspection" className="mt-1 flex h-12 items-center justify-center rounded-md bg-green-700 font-bold text-white">
            次の1台へ
          </Link>
        </div>
      ) : view.status === "assembling" ? (
        <p className="rounded-md bg-amber-100 px-4 py-3 text-amber-950">
          この個体は組立に戻っています。組立を完了すると、検品は①からやり直しです。
          <Link href={`/assembly/${view.mgmtNo}`} className="ml-1 font-bold underline">
            組立の画面へ
          </Link>
        </p>
      ) : view.stage === null ? (
        <p className="rounded-md bg-stone-200 px-4 py-3 text-stone-900">
          この個体は「{label(unitStatusLabel, view.status)}」です。検品の対象ではありません。
        </p>
      ) : own ? (
        <p role="alert" className="rounded-md bg-red-100 px-4 py-3 text-red-900">
          この個体は {viewer.user.name} さんが組み立てたので、検品できません。別の人に検品してもらってください。
        </p>
      ) : (
        <>
          <h2 className="text-xl font-bold">{stageLabel[view.stage]}</h2>
          <PhotoPanel
            key={`${view.stage}-${view.records.length}`}
            mgmtNo={view.mgmtNo}
            stage={view.stage}
            photos={view.pendingPhotos.map((p) => ({ id: p.id, kind: p.kind, takenBy: p.takenBy, takenAt: ymdHm(p.takenAt) }))}
          />
          <StageForm
            mgmtNo={view.mgmtNo}
            stage={view.stage}
            items={settings.checklist[view.stage]}
            limits={settings.limits}
            formKey={`${view.stage}-${view.records.length}`}
            photoMissing={photoMissing}
          />
        </>
      )}

      {current.length > 0 && <Records title="今回の検品の記録" records={current} />}
      {older.length > 0 && <Records title="前の回（組立に戻す前）の記録" records={older} collapsed />}
      {viewer.kind === "user" && (
        <Link href={`/trace/${view.mgmtNo}`} className="text-sm text-blue-800 underline">
          個体の履歴（使った部品など）を見る
        </Link>
      )}
    </>
  );
}

function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
}

function Records({ title, records, collapsed = false }: { title: string; records: InspectionRecord[]; collapsed?: boolean }) {
  const list = (
    <ul className="flex flex-col gap-2">
      {records.map((r) => {
        const notOk = Object.entries(r.checklist).filter(([, v]) => v !== true);
        return (
          <li key={r.id} className="flex flex-col gap-1 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              {r.result === "pass" ? <Tag tone="green">合格</Tag> : <Tag tone="red">不合格</Tag>}
              <span className="font-bold">{stageLabel[r.stage]}</span>
              <span className="text-stone-600">
                {ymdHm(r.finishedAt)}・{r.inspector}・{minutesBetween(r.startedAt, r.finishedAt)}分
              </span>
            </span>
            {r.stage === "software" && r.stressTestMinutes !== null && (
              <span className="text-stone-700">
                負荷試験 {r.stressTestMinutes}分・CPU {r.maxCpuTempC ?? "—"}℃・GPU {r.maxGpuTempC ?? "—"}℃・騒音{" "}
                {r.noiseDb ?? "—"}dB
              </span>
            )}
            {r.benchmarks.length > 0 && (
              <span className="text-stone-700">
                {r.benchmarks.map((b) => `${b.name} ${b.score.toLocaleString("ja-JP")}`).join("・")}
              </span>
            )}
            {notOk.length > 0 && (
              <span className="text-stone-700">
                {notOk.map(([k, v]) => `${k}：${v === "na" ? "該当なし" : "NG"}`).join("、")}
              </span>
            )}
            {r.warnings.length > 0 && (
              <span className="text-amber-900">
                上限超え：{r.warnings.join("、")}
                {r.warningReason && `（理由：${r.warningReason}）`}
              </span>
            )}
            {r.note && <span className="text-stone-800">メモ：{r.note}</span>}
            {r.nextAction && (
              <span className="text-red-800">{r.nextAction === "rework" ? "→ 組立に戻した" : "→ この段階をやり直し"}</span>
            )}
            {r.photos.length > 0 && (
              <span className="flex flex-wrap gap-2">
                {r.photos.map((p) => (
                  <a key={p.id} href={`/inspection/photos/${p.id}`} target="_blank" rel="noreferrer" className="text-blue-800 underline">
                    {photoKindLabel[p.kind]}（{ymdHm(p.takenAt)}）
                  </a>
                ))}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
  return (
    <section className="flex flex-col gap-2">
      {collapsed ? (
        <details>
          <summary className="cursor-pointer font-bold">
            {title}（{records.length}件）
          </summary>
          <div className="mt-2">{list}</div>
        </details>
      ) : (
        <>
          <h2 className="font-bold">{title}</h2>
          {list}
        </>
      )}
    </section>
  );
}
