import "server-only";
import type { PoolClient } from "pg";
import { isMgmtNo, mgmtNoFromLabel, normalizeCode } from "@/lib/codes";
import { query, withActor } from "@/lib/db";
import { slotLabel } from "@/lib/labels";

// 組立担当が使う処理。読み取り機（キーボードとして動くバーコードリーダー）から入った文字を受け取る。
// 書き込みはすべて withActor の中で行い、監査ログに「誰が」を残す。
// workerId は、呼ぶ側（app/assembly/actions.ts）が requireAssembler でログインから決めたものを渡す。

/** 部品を読んで取り付けられる状態 */
const OPEN_STATUSES = ["planned", "assembling"];

export type SkuOption = { id: number; code: string; name: string };

export async function listSkus(): Promise<SkuOption[]> {
  return query<SkuOption>(`SELECT id, code, name FROM core.skus WHERE active ORDER BY code`);
}

export type InProgressUnit = {
  mgmtNo: string;
  skuCode: string;
  assembledBy: string | null;
  filled: number;
  total: number;
};

/** 組立中の個体（新しい順） */
export async function listInProgress(): Promise<InProgressUnit[]> {
  return query<InProgressUnit>(
    `SELECT u.mgmt_no AS "mgmtNo", s.code AS "skuCode", us.display_name AS "assembledBy",
            (SELECT coalesce(sum(LEAST(ss.qty, (SELECT count(*) FROM core.unit_parts up
                                                   WHERE up.unit_id = u.id AND up.slot = ss.slot AND up.removed_at IS NULL))), 0)
               FROM core.sku_slots ss WHERE ss.sku_id = u.sku_id AND ss.required)::int AS filled,
            (SELECT coalesce(sum(qty), 0) FROM core.sku_slots ss WHERE ss.sku_id = u.sku_id AND ss.required)::int AS total
       FROM core.units u
       JOIN core.skus s ON s.id = u.sku_id
       LEFT JOIN core.users us ON us.id = u.assembled_by
      WHERE u.status = ANY($1)
      ORDER BY u.created_at DESC`,
    [OPEN_STATUSES],
  );
}

/** 新しく1台組み立て始める。管理番号を発行して返す */
export async function startUnit(workerId: number, skuId: number): Promise<string> {
  return withActor({ kind: "user", userId: workerId }, async (client) => {
    const r = await client.query<{ mgmt_no: string }>(
      `INSERT INTO core.units (sku_id, status, assembled_by)
       SELECT id, 'assembling', $2 FROM core.skus WHERE id = $1 AND active
       RETURNING mgmt_no`,
      [skuId, workerId],
    );
    if (r.rowCount !== 1) throw new Error("その機種は選べません");
    return r.rows[0].mgmt_no;
  });
}

// ---------------------------------------------------------------------
// 組立画面の表示
// ---------------------------------------------------------------------

export type AssemblySlot = {
  slot: string;
  label: string;
  qty: number;
  options: string[]; // 使ってよい部品の名前（型番）
  installed: { name: string; serialNo: string | null; by: string | null; at: Date }[];
  done: boolean;
  /** false なら付けなくても組立を完了できる */
  required: boolean;
  /** true なら登録済みの部品なら何でも付けられる（自由枠） */
  anyPart: boolean;
};

export type UnitNote = { id: number; note: string; by: string | null; at: Date };

export type AssemblyView = {
  mgmtNo: string;
  status: string;
  sku: { code: string; name: string };
  assembledBy: string | null;
  canScan: boolean;
  slots: AssemblySlot[];
  filled: number;
  total: number;
  nextSlot: string | null;
  notes: UnitNote[];
};

export async function getAssembly(rawMgmtNo: string): Promise<AssemblyView | null> {
  const mgmtNo = normalizeCode(rawMgmtNo);
  const [unit] = await query<{
    id: number;
    sku_id: number;
    status: string;
    sku_code: string;
    sku_name: string;
    assembled_by: string | null;
  }>(
    `SELECT u.id, u.sku_id, u.status, s.code AS sku_code, s.name AS sku_name, us.display_name AS assembled_by
       FROM core.units u JOIN core.skus s ON s.id = u.sku_id
       LEFT JOIN core.users us ON us.id = u.assembled_by
      WHERE u.mgmt_no = $1`,
    [mgmtNo],
  );
  if (!unit) return null;

  const [slotRows, optionRows, installedRows] = await Promise.all([
    query<{ slot: string; qty: number; required: boolean; any_part: boolean }>(
      `SELECT slot, qty, required, any_part FROM core.sku_slots WHERE sku_id = $1 ORDER BY sort_order, slot`,
      [unit.sku_id],
    ),
    query<{ slot: string; name: string; model_no: string }>(
      `SELECT ss.slot, pm.name, pm.model_no
         FROM core.sku_slots ss
         JOIN core.sku_slot_options o ON o.slot_id = ss.id
         JOIN core.part_models pm ON pm.id = o.part_model_id
        WHERE ss.sku_id = $1 ORDER BY pm.model_no`,
      [unit.sku_id],
    ),
    query<{ slot: string; name: string; serial_no: string | null; by: string | null; at: Date }>(
      `SELECT up.slot, pm.name, p.serial_no, us.display_name AS by, up.installed_at AS at
         FROM core.unit_parts up
         JOIN core.part_items p ON p.id = up.part_item_id
         JOIN core.part_models pm ON pm.id = p.part_model_id
         LEFT JOIN core.users us ON us.id = up.installed_by
        WHERE up.unit_id = $1 AND up.removed_at IS NULL
        ORDER BY up.installed_at`,
      [unit.id],
    ),
  ]);
  const notes = await listUnitNotes(unit.id);

  const slots: AssemblySlot[] = slotRows.map((s) => {
    const installed = installedRows
      .filter((r) => r.slot === s.slot)
      .map((r) => ({ name: r.name, serialNo: r.serial_no, by: r.by, at: r.at }));
    return {
      slot: s.slot,
      label: slotLabel[s.slot] ?? s.slot,
      qty: s.qty,
      options: s.any_part
        ? ["登録済みの部品なら何でも"]
        : optionRows.filter((o) => o.slot === s.slot).map((o) => `${o.name}（${o.model_no}）`),
      installed,
      done: installed.length >= s.qty,
      required: s.required,
      anyPart: s.any_part,
    };
  });
  // 進み具合は「必ず付ける」枠だけで数える（付けなくてもよい枠は、付けたぶんだけ記録する）
  const required = slots.filter((s) => s.required);
  const total = required.reduce((n, s) => n + s.qty, 0);
  const filled = required.reduce((n, s) => n + Math.min(s.installed.length, s.qty), 0);

  return {
    mgmtNo,
    status: unit.status,
    sku: { code: unit.sku_code, name: unit.sku_name },
    assembledBy: unit.assembled_by,
    canScan: OPEN_STATUSES.includes(unit.status),
    slots,
    filled,
    total,
    nextSlot: required.find((s) => !s.done)?.slot ?? null,
    notes,
  };
}

// ---------------------------------------------------------------------
// バーコードを読んだとき
// ---------------------------------------------------------------------

export type ScanResult =
  | { kind: "installed"; slot: string; message: string }
  | { kind: "unit"; mgmtNo: string; message: string }
  | { kind: "error"; message: string };

/** 「この画面ではできない」ことを伝えるための失敗。トランザクションごと取り消す */
class ScanRefused extends Error {}

const statusText: Record<string, string> = {
  inspecting: "検品待ち",
  ready: "出荷待ち",
  inbound_to_fba: "FBAへ輸送中",
  at_fba: "FBA在庫",
  shipped: "出荷済み",
  returned: "返品",
  in_repair: "修理中",
  scrapped: "廃棄",
};

/**
 * 組立中の個体に、読んだ部品を取り付ける。
 * 部品はシリアルで探し、シリアルのない部品（ケースなど）はJANコードで在庫から1つ選ぶ。
 * 構成表にない型番・取り付け済みの枠・在庫にない部品は、取り付けずに理由を返す。
 */
export async function scanPart(workerId: number, rawMgmtNo: string, rawCode: string): Promise<ScanResult> {
  const mgmtNo = normalizeCode(rawMgmtNo);
  // 管理番号シールの QR（製品登録の URL）を読んだときは、管理番号として扱う
  const code = mgmtNoFromLabel(rawCode) ?? normalizeCode(rawCode);
  if (code === "") return { kind: "error", message: "読み取れませんでした。もう一度読んでください。" };

  // 別の管理番号のシールを読んだら、その個体の組立画面へ移る
  if (isMgmtNo(code)) {
    if (code === mgmtNo) return { kind: "error", message: `${code} はこの個体の管理番号です。部品のバーコードを読んでください。` };
    return { kind: "unit", mgmtNo: code, message: `${code} の組立画面に移ります。` };
  }

  try {
    return await withActor({ kind: "user", userId: workerId }, async (client) => {
      const unit = await lockUnit(client, mgmtNo);
      const item = await findPartItem(client, code);
      const slot = await chooseSlot(client, unit, item);

      await client.query(
        `INSERT INTO core.unit_parts (unit_id, slot, part_item_id, installed_by) VALUES ($1, $2, $3, $4)`,
        [unit.id, slot, item.id, workerId],
      );
      if (unit.status === "planned") {
        await client.query(`UPDATE core.units SET status = 'assembling' WHERE id = $1`, [unit.id]);
      }
      const label = slotLabel[slot] ?? slot;
      return {
        kind: "installed" as const,
        slot,
        message: `${label}：${item.name}${item.serial_no ? `（${item.serial_no}）` : ""} を取り付けました。`,
      };
    });
  } catch (error) {
    if (error instanceof ScanRefused) return { kind: "error", message: error.message };
    throw error;
  }
}

type LockedUnit = { id: number; sku_id: number; status: string };
type FoundItem = { id: number; part_model_id: number; name: string; model_no: string; category: string; serial_no: string | null };

async function lockUnit(client: PoolClient, mgmtNo: string): Promise<LockedUnit> {
  const r = await client.query<LockedUnit>(
    `SELECT id, sku_id, status FROM core.units WHERE mgmt_no = $1 FOR UPDATE`,
    [mgmtNo],
  );
  const unit = r.rows[0];
  if (!unit) throw new ScanRefused(`${mgmtNo} という個体はありません。`);
  if (!OPEN_STATUSES.includes(unit.status)) {
    throw new ScanRefused(`${mgmtNo} は組立中ではありません（今の状態：${statusText[unit.status] ?? unit.status}）。`);
  }
  return unit;
}

async function findPartItem(client: PoolClient, code: string): Promise<FoundItem> {
  // 1. シリアルで探す
  const bySerial = await client.query<FoundItem & { status: string; mgmt_no: string | null }>(
    `SELECT p.id, p.part_model_id, pm.name, pm.model_no, pm.category, p.serial_no, p.status,
            (SELECT u.mgmt_no FROM core.unit_parts up JOIN core.units u ON u.id = up.unit_id
              WHERE up.part_item_id = p.id AND up.removed_at IS NULL) AS mgmt_no
       FROM core.part_items p JOIN core.part_models pm ON pm.id = p.part_model_id
      WHERE upper(p.serial_no) = $1
      FOR UPDATE OF p`,
    [code],
  );
  if (bySerial.rows.length > 0) {
    const inStock = bySerial.rows.filter((r) => r.status === "in_stock");
    if (inStock.length === 1) return inStock[0];
    if (inStock.length > 1) {
      throw new ScanRefused(`シリアル ${code} の部品が複数あります（${inStock.map((r) => r.name).join("、")}）。代表に確認してください。`);
    }
    const r = bySerial.rows[0];
    if (r.status === "installed") throw new ScanRefused(`${r.name}（${code}）は、もう ${r.mgmt_no} に取り付け済みです。`);
    if (r.status === "in_rma") throw new ScanRefused(`${r.name}（${code}）はRMA中の部品です。使えません。`);
    throw new ScanRefused(`${r.name}（${code}）は在庫にありません。代表に確認してください。`);
  }

  // 2. JANコードで探す（シリアルのない部品だけ。古い在庫から使う）
  const model = await client.query<{ id: number; name: string; serial_required: boolean }>(
    `SELECT id, name, serial_required FROM core.part_models WHERE jan_code = $1`,
    [code],
  );
  if (model.rows.length === 1) {
    const m = model.rows[0];
    if (m.serial_required) {
      throw new ScanRefused(`${m.name} はシリアル番号のバーコードを読んでください（今読んだのはJANコードです）。`);
    }
    const item = await client.query<FoundItem>(
      `SELECT p.id, p.part_model_id, pm.name, pm.model_no, pm.category, p.serial_no
         FROM core.part_items p JOIN core.part_models pm ON pm.id = p.part_model_id
        WHERE p.part_model_id = $1 AND p.status = 'in_stock'
        ORDER BY p.received_at, p.id
        LIMIT 1
        FOR UPDATE OF p SKIP LOCKED`,
      [m.id],
    );
    if (item.rows.length === 0) throw new ScanRefused(`${m.name} の在庫がありません。仕入れの登録を確認してください。`);
    return item.rows[0];
  }

  throw new ScanRefused(`「${code}」の部品は登録されていません。仕入れの登録を確認するか、別のバーコードを読んでください。`);
}

async function chooseSlot(client: PoolClient, unit: LockedUnit, item: FoundItem): Promise<string> {
  // この部品を使ってよい枠と、そこに付いている数
  // 型番が決まっている枠を先に、自由枠（何でも付けられる枠）はあとに使う
  const r = await client.query<{ slot: string; qty: number; filled: number }>(
    `SELECT ss.slot, ss.qty,
            (SELECT count(*) FROM core.unit_parts up
              WHERE up.unit_id = $1 AND up.slot = ss.slot AND up.removed_at IS NULL)::int AS filled
       FROM core.sku_slots ss
      WHERE ss.sku_id = $2
        AND (ss.any_part OR EXISTS (SELECT 1 FROM core.sku_slot_options o
                                     WHERE o.slot_id = ss.id AND o.part_model_id = $3))
      ORDER BY ss.any_part, ss.sort_order`,
    [unit.id, unit.sku_id, item.part_model_id],
  );
  if (r.rows.length === 0) {
    // 同じ種類の枠で使える型番を案内する
    const allowed = await client.query<{ slot: string; model_no: string }>(
      `SELECT ss.slot, pm.model_no
         FROM core.sku_slots ss
         JOIN core.sku_slot_options o ON o.slot_id = ss.id
         JOIN core.part_models pm ON pm.id = o.part_model_id
        WHERE ss.sku_id = $1 AND ss.category = $2
        ORDER BY pm.model_no`,
      [unit.sku_id, item.category],
    );
    const hint = allowed.rows.length > 0
      ? `この機種の${slotLabel[allowed.rows[0].slot] ?? allowed.rows[0].slot}に使えるのは ${allowed.rows.map((a) => a.model_no).join(" / ")} です。`
      : "";
    throw new ScanRefused(`${item.name}（${item.model_no}）はこの機種の構成表にありません。${hint}`);
  }
  const free = r.rows.find((s) => s.filled < s.qty);
  if (!free) {
    throw new ScanRefused(`${slotLabel[r.rows[0].slot] ?? r.rows[0].slot}はもう取り付け済みです。間違えた場合は「1つ取り消す」を押してください。`);
  }
  return free.slot;
}

// ---------------------------------------------------------------------
// 取り消し・完了
// ---------------------------------------------------------------------

export type ActionResult = { ok: boolean; message: string };

/** 最後に取り付けた部品を外し、在庫に戻す（読み間違いのやり直し用） */
export async function undoLast(workerId: number, rawMgmtNo: string): Promise<ActionResult> {
  const mgmtNo = normalizeCode(rawMgmtNo);
  try {
    return await withActor({ kind: "user", userId: workerId }, async (client) => {
      const unit = await lockUnit(client, mgmtNo);
      const r = await client.query<{ id: number; slot: string; name: string; serial_no: string | null }>(
        `UPDATE core.unit_parts up
            SET removed_at = now(), removed_by = $2, remove_reason = '組立中の取り消し（読み間違いなど）'
          WHERE up.id = (SELECT id FROM core.unit_parts
                          WHERE unit_id = $1 AND removed_at IS NULL
                          ORDER BY installed_at DESC, id DESC LIMIT 1)
         RETURNING up.id, up.slot,
                   (SELECT pm.name FROM core.part_items p JOIN core.part_models pm ON pm.id = p.part_model_id
                     WHERE p.id = up.part_item_id) AS name,
                   (SELECT p.serial_no FROM core.part_items p WHERE p.id = up.part_item_id) AS serial_no`,
        [unit.id, workerId],
      );
      if (r.rows.length === 0) throw new ScanRefused("取り消す部品がありません。");
      const p = r.rows[0];
      return {
        ok: true,
        message: `${slotLabel[p.slot] ?? p.slot}：${p.name}${p.serial_no ? `（${p.serial_no}）` : ""} を外して在庫に戻しました。`,
      };
    });
  } catch (error) {
    if (error instanceof ScanRefused) return { ok: false, message: error.message };
    throw error;
  }
}

/** 「必ず付ける」枠に部品が全部付いたら、組立完了にして検品待ちにする */
export async function finishAssembly(workerId: number, rawMgmtNo: string): Promise<ActionResult> {
  const mgmtNo = normalizeCode(rawMgmtNo);
  try {
    return await withActor({ kind: "user", userId: workerId }, async (client) => {
      const unit = await lockUnit(client, mgmtNo);
      const missing = await client.query<{ slot: string }>(
        `SELECT ss.slot FROM core.sku_slots ss
          WHERE ss.sku_id = $1 AND ss.required
            AND (SELECT count(*) FROM core.unit_parts up
                  WHERE up.unit_id = $2 AND up.slot = ss.slot AND up.removed_at IS NULL) < ss.qty
          ORDER BY ss.sort_order`,
        [unit.sku_id, unit.id],
      );
      if (missing.rows.length > 0) {
        throw new ScanRefused(`まだ付いていない部品があります：${missing.rows.map((m) => slotLabel[m.slot] ?? m.slot).join("、")}`);
      }
      await client.query(
        `UPDATE core.units
            SET status = 'inspecting', assembled_at = now(), assembled_by = coalesce(assembled_by, $2)
          WHERE id = $1`,
        [unit.id, workerId],
      );
      return { ok: true, message: `${mgmtNo} の組立が完了しました。検品に回してください。` };
    });
  } catch (error) {
    if (error instanceof ScanRefused) return { ok: false, message: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------
// 個体のメモ（在庫を使わない作業・部品を文字で残す）
// ---------------------------------------------------------------------

async function listUnitNotes(unitId: number): Promise<UnitNote[]> {
  return query<UnitNote>(
    `SELECT n.id, n.note, us.display_name AS by, n.created_at AS at
       FROM core.unit_notes n LEFT JOIN core.users us ON us.id = n.created_by
      WHERE n.unit_id = $1 AND n.removed_at IS NULL
      ORDER BY n.created_at, n.id`,
    [unitId],
  );
}

/** メモを足す（例：LEDテープを追加、ケーブルを交換）。組立中の個体だけ */
export async function addUnitNote(workerId: number, rawMgmtNo: string, rawNote: string): Promise<ActionResult> {
  const note = rawNote.normalize("NFC").replace(/\s+/g, " ").trim();
  if (note.length < 1 || note.length > 200) return { ok: false, message: "メモは1〜200文字で書いてください。" };
  const mgmtNo = normalizeCode(rawMgmtNo);
  try {
    return await withActor({ kind: "user", userId: workerId }, async (client) => {
      const unit = await lockUnit(client, mgmtNo);
      await client.query(`INSERT INTO core.unit_notes (unit_id, note, created_by) VALUES ($1, $2, $3)`, [
        unit.id,
        note,
        workerId,
      ]);
      return { ok: true, message: "メモを残しました。" };
    });
  } catch (error) {
    if (error instanceof ScanRefused) return { ok: false, message: error.message };
    throw error;
  }
}

/** メモを取り消す（消さずに取り消しの印を付ける） */
export async function removeUnitNote(workerId: number, rawMgmtNo: string, noteId: number): Promise<ActionResult> {
  const mgmtNo = normalizeCode(rawMgmtNo);
  try {
    return await withActor({ kind: "user", userId: workerId }, async (client) => {
      const unit = await lockUnit(client, mgmtNo);
      const r = await client.query(
        `UPDATE core.unit_notes SET removed_at = now(), removed_by = $3
          WHERE id = $1 AND unit_id = $2 AND removed_at IS NULL`,
        [noteId, unit.id, workerId],
      );
      return r.rowCount === 1 ? { ok: true, message: "メモを取り消しました。" } : { ok: false, message: "そのメモはありません。" };
    });
  } catch (error) {
    if (error instanceof ScanRefused) return { ok: false, message: error.message };
    throw error;
  }
}
