import "server-only";
import { createHash } from "node:crypto";
import { DatabaseError, type PoolClient } from "pg";
import { INSPECTION_ROLES } from "@/lib/auth/store";
import { normalizeSearch } from "@/lib/codes";
import { query, withActor } from "@/lib/db";
import { detectFileType } from "@/lib/document-calc";
import {
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_STAGE,
  PHOTO_KINDS,
  REQUIRED_PHOTO,
  STAGES,
  nextStage,
  parseChecklist,
  parseInspectionInput,
  parseLimits,
  photoKindLabel,
  stageLabel,
  type Benchmark,
  type Checklist,
  type InspectionRaw,
  type Limits,
  type PhotoKind,
  type Stage,
} from "@/lib/inspection-calc";
import { saveFile } from "@/lib/storage";

// 検品（3段階）の読み書き。書き込みはすべて withActor の中で行い、監査ログに「誰が」を残す。
// actorId は、呼ぶ側（app/inspection/actions.ts）が requireInspector でログインから決めたものを渡す。
// 決まり（順番・本人以外・写真）は DB のトリガー（0013）でも止めるが、分かりやすい言葉で先に断る。

export type ActionResult = { ok: boolean; message: string };

class Refused extends Error {}

function dbMessage(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  if (error.code === "P0001") return error.message; // 0013 のトリガーの日本語のメッセージ
  if (error.code === "23514") return "入力が決まりに合っていません。もう一度確かめてください。";
  return null;
}

export async function getInspectionSettings(): Promise<{ limits: Limits; checklist: Checklist }> {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM core.settings WHERE key IN ('inspection.limits', 'inspection.checklist')`,
  );
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return { limits: parseLimits(get("inspection.limits")), checklist: parseChecklist(get("inspection.checklist")) };
}

/** 今その人が検品の役割を持っているか（画面の確認に加えて、書き込みの直前にも見る） */
async function hasInspectionRole(client: PoolClient, userId: number): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM core.role_assignments
      WHERE user_id = $1 AND role_code = ANY($2)
        AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
    [userId, INSPECTION_ROLES],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------
// 検品待ちの一覧
// ---------------------------------------------------------------------

export type QueueUnit = {
  mgmtNo: string;
  skuCode: string;
  assembledBy: string | null;
  assembledById: number | null;
  assembledAt: Date | null;
  stage: Stage;
  lastFail: string | null;
};

export async function listInspectionQueue(): Promise<QueueUnit[]> {
  const rows = await query<{
    mgmtNo: string;
    skuCode: string;
    assembledBy: string | null;
    assembledById: number | null;
    assembledAt: Date | null;
    passed: Stage[];
    lastFail: string | null;
  }>(
    `SELECT u.mgmt_no AS "mgmtNo", s.code AS "skuCode", ab.display_name AS "assembledBy",
            u.assembled_by AS "assembledById", u.assembled_at AS "assembledAt",
            ARRAY(SELECT i.stage FROM core.inspections i
                   WHERE i.unit_id = u.id AND i.result = 'pass'
                     AND i.finished_at > coalesce(u.assembled_at, '-infinity')) AS passed,
            (SELECT i.note FROM core.inspections i
              WHERE i.unit_id = u.id AND i.result = 'fail'
                AND i.finished_at > coalesce(u.assembled_at, '-infinity')
              ORDER BY i.finished_at DESC LIMIT 1) AS "lastFail"
       FROM core.units u
       JOIN core.skus s ON s.id = u.sku_id
       LEFT JOIN core.users ab ON ab.id = u.assembled_by
      WHERE u.status = 'inspecting'
      ORDER BY u.assembled_at NULLS FIRST, u.id`,
  );
  return rows.map(({ passed, ...r }) => ({ ...r, stage: nextStage(passed) ?? "final" }));
}

// ---------------------------------------------------------------------
// 1台の検品
// ---------------------------------------------------------------------

export type InspectionPhoto = {
  id: number;
  stage: Stage;
  kind: PhotoKind;
  takenBy: string;
  takenAt: Date;
  /** 段階の記録に使った（もう取り消せない） */
  attached: boolean;
};

export type InspectionRecord = {
  id: number;
  stage: Stage;
  result: "pass" | "fail";
  inspector: string;
  startedAt: Date;
  finishedAt: Date;
  checklist: Record<string, boolean | "na">;
  stressTestMinutes: number | null;
  maxCpuTempC: number | null;
  maxGpuTempC: number | null;
  noiseDb: number | null;
  benchmarks: Benchmark[];
  warnings: string[];
  warningReason: string | null;
  note: string | null;
  nextAction: "retry" | "rework" | null;
  /** 今の回（最後に組立を完了してから）の記録か */
  current: boolean;
  photos: InspectionPhoto[];
};

export type InspectionView = {
  mgmtNo: string;
  status: string;
  sku: { code: string; name: string };
  assembledBy: { id: number; name: string } | null;
  assembledAt: Date | null;
  inspectedAt: Date | null;
  /** 次に検品する段階（検品中でなければ null） */
  stage: Stage | null;
  passed: Stage[];
  /** 今の段階で撮った、まだ記録に使っていない写真 */
  pendingPhotos: InspectionPhoto[];
  records: InspectionRecord[];
};

export async function getInspection(rawMgmtNo: string): Promise<InspectionView | null> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  const [unit] = await query<{
    id: number;
    mgmt_no: string;
    status: string;
    sku_code: string;
    sku_name: string;
    assembled_by: number | null;
    assembled_by_name: string | null;
    assembled_at: Date | null;
    inspected_at: Date | null;
  }>(
    `SELECT u.id, u.mgmt_no, u.status, s.code AS sku_code, s.name AS sku_name,
            u.assembled_by, ab.display_name AS assembled_by_name, u.assembled_at, u.inspected_at
       FROM core.units u JOIN core.skus s ON s.id = u.sku_id
       LEFT JOIN core.users ab ON ab.id = u.assembled_by
      WHERE u.mgmt_no = $1`,
    [mgmtNo],
  );
  if (!unit) return null;
  const round = unit.assembled_at ?? new Date(0);

  const [recordRows, photoRows] = await Promise.all([
    query<{
      id: number;
      stage: Stage;
      result: "pass" | "fail";
      inspector: string;
      started_at: Date;
      finished_at: Date;
      checklist: Record<string, boolean | "na">;
      stress_test_minutes: number | null;
      max_cpu_temp_c: number | null;
      max_gpu_temp_c: number | null;
      noise_db: number | null;
      benchmarks: Benchmark[];
      warnings: string[];
      warning_reason: string | null;
      note: string | null;
      next_action: "retry" | "rework" | null;
    }>(
      `SELECT i.id, i.stage, i.result, us.display_name AS inspector, i.started_at, i.finished_at, i.checklist,
              i.stress_test_minutes, i.max_cpu_temp_c, i.max_gpu_temp_c, i.noise_db, i.benchmarks,
              i.warnings, i.warning_reason, i.note, i.next_action
         FROM core.inspections i JOIN core.users us ON us.id = i.inspector_id
        WHERE i.unit_id = $1
        ORDER BY i.finished_at DESC, i.id DESC`,
      [unit.id],
    ),
    query<{
      id: number;
      stage: Stage;
      kind: PhotoKind;
      inspection_id: number | null;
      taken_by: string;
      taken_at: Date;
    }>(
      `SELECT p.id, p.stage, p.kind, p.inspection_id, us.display_name AS taken_by, p.taken_at
         FROM core.inspection_photos p JOIN core.users us ON us.id = p.taken_by
        WHERE p.unit_id = $1 AND p.removed_at IS NULL
        ORDER BY p.taken_at, p.id`,
      [unit.id],
    ),
  ]);

  const photo = (p: (typeof photoRows)[number]): InspectionPhoto => ({
    id: p.id,
    stage: p.stage,
    kind: p.kind,
    takenBy: p.taken_by,
    takenAt: p.taken_at,
    attached: p.inspection_id !== null,
  });
  const records: InspectionRecord[] = recordRows.map((r) => ({
    id: r.id,
    stage: r.stage,
    result: r.result,
    inspector: r.inspector,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    checklist: r.checklist,
    stressTestMinutes: r.stress_test_minutes,
    maxCpuTempC: r.max_cpu_temp_c,
    maxGpuTempC: r.max_gpu_temp_c,
    noiseDb: r.noise_db,
    benchmarks: r.benchmarks,
    warnings: r.warnings,
    warningReason: r.warning_reason,
    note: r.note,
    nextAction: r.next_action,
    current: r.finished_at > round,
    photos: photoRows.filter((p) => p.inspection_id === r.id).map(photo),
  }));
  const passed = STAGES.filter((s) => records.some((r) => r.current && r.stage === s && r.result === "pass"));
  const stage = unit.status === "inspecting" ? nextStage(passed) : null;

  return {
    mgmtNo: unit.mgmt_no,
    status: unit.status,
    sku: { code: unit.sku_code, name: unit.sku_name },
    assembledBy: unit.assembled_by ? { id: unit.assembled_by, name: unit.assembled_by_name ?? "" } : null,
    assembledAt: unit.assembled_at,
    inspectedAt: unit.inspected_at,
    stage,
    passed,
    pendingPhotos: stage
      ? photoRows.filter((p) => p.inspection_id === null && p.stage === stage && p.taken_at > round).map(photo)
      : [],
    records,
  };
}

type LockedUnit = { id: number; status: string; assembled_by: number | null; assembled_at: Date | null };

/** 検品中の個体を押さえ、今の段階を返す（別の人が同時に記録しても順番が崩れないように） */
async function lockForInspection(client: PoolClient, mgmtNo: string, inspectorId: number): Promise<{ unit: LockedUnit; stage: Stage }> {
  const r = await client.query<LockedUnit>(
    `SELECT id, status, assembled_by, assembled_at FROM core.units WHERE mgmt_no = $1 FOR UPDATE`,
    [mgmtNo],
  );
  const unit = r.rows[0];
  if (!unit) throw new Refused(`${mgmtNo} という個体はありません。`);
  if (unit.status !== "inspecting") throw new Refused(`${mgmtNo} は検品中ではありません。`);
  if (!(await hasInspectionRole(client, inspectorId))) throw new Refused("検品の役割がありません。代表に「検品を任せる」を付けてもらってください。");
  if (unit.assembled_by === inspectorId) {
    throw new Refused("組み立てた本人は検品できません。別の人に検品してもらってください。");
  }
  const passed = await client.query<{ stage: Stage }>(
    `SELECT stage FROM core.inspections
      WHERE unit_id = $1 AND result = 'pass' AND finished_at > coalesce($2::timestamptz, '-infinity')`,
    [unit.id, unit.assembled_at],
  );
  const stage = nextStage(passed.rows.map((p) => p.stage));
  if (!stage) throw new Refused(`${mgmtNo} の検品はもう終わっています。`);
  return { unit, stage };
}

/** 写真を足す（今の段階の分だけ）。ファイルは中身のハッシュの名前で保存し、上書きしない */
export async function addInspectionPhoto(
  inspectorId: number,
  rawMgmtNo: string,
  rawStage: string,
  rawKind: string,
  bytes: Uint8Array,
): Promise<ActionResult> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  if (bytes.byteLength === 0) return { ok: false, message: "写真が選ばれていません。" };
  if (bytes.byteLength > MAX_PHOTO_BYTES) return { ok: false, message: "写真は1枚20MBまでです。" };
  const type = detectFileType(bytes);
  if (!type || type.ext === "pdf") return { ok: false, message: "写真（JPEG・PNG・WebP・HEIC）を選んでください。" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  try {
    return await withActor({ kind: "user", userId: inspectorId }, async (client) => {
      const { unit, stage } = await lockForInspection(client, mgmtNo, inspectorId);
      if (rawStage !== stage) throw new Refused("段階が変わりました。画面を読み込み直してください。");
      const kind = PHOTO_KINDS[stage].find((k) => k === rawKind);
      if (!kind) throw new Refused("この段階では撮れない種類の写真です。");
      const count = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM core.inspection_photos
          WHERE unit_id = $1 AND stage = $2 AND inspection_id IS NULL AND removed_at IS NULL
            AND taken_at > coalesce($3::timestamptz, '-infinity')`,
        [unit.id, stage, unit.assembled_at],
      );
      if (count.rows[0].n >= MAX_PHOTOS_PER_STAGE) {
        throw new Refused(`1つの段階の写真は ${MAX_PHOTOS_PER_STAGE} 枚までです。`);
      }
      const uri = await saveFile(bytes, sha256, type.ext);
      await client.query(
        `INSERT INTO core.inspection_photos (unit_id, stage, kind, storage_uri, sha256, mime_type, size_bytes, taken_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [unit.id, stage, kind, uri, sha256, type.mime, bytes.byteLength, inspectorId],
      );
      return { ok: true, message: `${photoKindLabel[kind]}を残しました。` };
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, message: error.message };
    const m = dbMessage(error);
    if (m) return { ok: false, message: m };
    throw error;
  }
}

/** まだ記録に使っていない写真を取り消す（撮り間違い） */
export async function removeInspectionPhoto(inspectorId: number, rawMgmtNo: string, photoId: number): Promise<ActionResult> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  try {
    return await withActor({ kind: "user", userId: inspectorId }, async (client) => {
      const { unit } = await lockForInspection(client, mgmtNo, inspectorId);
      const r = await client.query(
        `UPDATE core.inspection_photos SET removed_at = now(), removed_by = $3
          WHERE id = $1 AND unit_id = $2 AND inspection_id IS NULL AND removed_at IS NULL`,
        [photoId, unit.id, inspectorId],
      );
      if (r.rowCount !== 1) throw new Refused("この写真は取り消せません（記録に使った写真は取り消せません）。");
      return { ok: true, message: "写真を取り消しました。" };
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, message: error.message };
    throw error;
  }
}

export type RecordResult =
  | { ok: true; message: string; done: boolean }
  | { ok: false; message: string; errors?: string[] };

/** 段階の結果を記録する。③に合格したら出荷できる状態に、「組立に戻す」なら組立中に戻す */
export async function recordInspection(
  inspectorId: number,
  rawMgmtNo: string,
  rawStage: string,
  raw: InspectionRaw,
): Promise<RecordResult> {
  const mgmtNo = normalizeSearch(rawMgmtNo);
  const { limits, checklist } = await getInspectionSettings();
  try {
    return await withActor({ kind: "user", userId: inspectorId }, async (client) => {
      const { unit, stage } = await lockForInspection(client, mgmtNo, inspectorId);
      if (rawStage !== stage) throw new Refused("段階が変わりました。画面を読み込み直してください。");
      const parsed = parseInspectionInput(stage, checklist[stage], limits, raw);
      if (!parsed.ok) return { ok: false, message: "入力を確かめてください。", errors: parsed.errors };
      const v = parsed.value;

      const required = REQUIRED_PHOTO[stage];
      if (v.result === "pass" && required) {
        const has = await client.query(
          `SELECT 1 FROM core.inspection_photos
            WHERE unit_id = $1 AND stage = $2 AND kind = $3 AND inspection_id IS NULL AND removed_at IS NULL
              AND taken_at > coalesce($4::timestamptz, '-infinity')`,
          [unit.id, stage, required, unit.assembled_at],
        );
        if (!has.rowCount) throw new Refused(`合格にするには「${photoKindLabel[required]}」が要ります。`);
      }

      // この段階を始めた時刻＝前の記録（今の回）か、組立を完了した時刻（作業時間を見るため）
      const prev = await client.query<{ at: Date | null }>(
        `SELECT max(finished_at) AS at FROM core.inspections
          WHERE unit_id = $1 AND finished_at > coalesce($2::timestamptz, '-infinity')`,
        [unit.id, unit.assembled_at],
      );
      const startedAt = prev.rows[0].at ?? unit.assembled_at ?? new Date();

      const ins = await client.query<{ id: number }>(
        `INSERT INTO core.inspections
           (unit_id, inspector_id, stage, started_at, result, checklist, stress_test_minutes,
            max_cpu_temp_c, max_gpu_temp_c, noise_db, benchmarks, warnings, warning_reason, note, next_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          unit.id,
          inspectorId,
          stage,
          startedAt,
          v.result,
          JSON.stringify(v.checklist),
          v.measurements.stressTestMinutes,
          v.measurements.maxCpuTempC,
          v.measurements.maxGpuTempC,
          v.measurements.noiseDb,
          JSON.stringify(v.benchmarks),
          v.warnings,
          v.warningReason,
          v.note,
          v.nextAction,
        ],
      );
      const id = ins.rows[0].id;
      await client.query(
        `UPDATE core.inspection_photos SET inspection_id = $1
          WHERE unit_id = $2 AND stage = $3 AND inspection_id IS NULL AND removed_at IS NULL
            AND taken_at > coalesce($4::timestamptz, '-infinity')`,
        [id, unit.id, stage, unit.assembled_at],
      );

      if (v.result === "fail") {
        if (v.nextAction === "rework") {
          await client.query(`UPDATE core.units SET status = 'assembling' WHERE id = $1`, [unit.id]);
          return {
            ok: true,
            done: false,
            message: `${stageLabel[stage]} を不合格にして、組立に戻しました。部品を替えて組立を完了したら、検品は①からやり直しです。`,
          };
        }
        return { ok: true, done: false, message: `${stageLabel[stage]} を不合格にしました。直したら、この段階をもう一度検品してください。` };
      }
      if (stage === "final") {
        await client.query(
          `UPDATE core.units SET status = 'ready', inspected_by = $2, inspected_at = now() WHERE id = $1`,
          [unit.id, inspectorId],
        );
        return { ok: true, done: true, message: `${mgmtNo} の検品がすべて終わりました。出荷できます。` };
      }
      return { ok: true, done: false, message: `${stageLabel[stage]} に合格しました。` };
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, message: error.message };
    const m = dbMessage(error);
    if (m) return { ok: false, message: m };
    throw error;
  }
}

/** 写真のファイルの場所（表示用） */
export async function getInspectionPhotoFile(id: number): Promise<{ storageUri: string; mimeType: string; mgmtNo: string } | null> {
  const [r] = await query<{ storageUri: string; mimeType: string; mgmtNo: string }>(
    `SELECT p.storage_uri AS "storageUri", p.mime_type AS "mimeType", u.mgmt_no AS "mgmtNo"
       FROM core.inspection_photos p JOIN core.units u ON u.id = p.unit_id
      WHERE p.id = $1`,
    [id],
  );
  return r ?? null;
}

/** 検品で「組立に戻す」になった個体なら、その理由（組立の画面に出す） */
export async function getReworkRequest(rawMgmtNo: string): Promise<{ note: string; by: string; at: Date } | null> {
  const [r] = await query<{ note: string; by: string; at: Date }>(
    `SELECT i.note, us.display_name AS by, i.finished_at AS at
       FROM core.units u
       JOIN core.inspections i ON i.unit_id = u.id
       JOIN core.users us ON us.id = i.inspector_id
      WHERE u.mgmt_no = $1 AND u.status = 'assembling' AND i.next_action = 'rework'
        AND i.finished_at > coalesce(u.assembled_at, '-infinity')
      ORDER BY i.finished_at DESC LIMIT 1`,
    [normalizeSearch(rawMgmtNo)],
  );
  return r ?? null;
}
