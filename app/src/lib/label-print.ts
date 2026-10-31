import "server-only";
import QRCode from "qrcode";
import { query, withActor } from "@/lib/db";

// 管理番号シールを刷るための読み取りと、刷った記録。
// actorId は、呼ぶ側（app/labels/actions.ts）が requireAssembler でログインから決めたものを渡す。

/** QR を SVG の文字で作る（誤り訂正は M。テープが少し汚れても読める） */
export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 0 });
}

export type LabelUnit = { mgmtNo: string; skuCode: string; status: string; createdAt: Date; printedAt: Date | null };

/** シールを刷る個体（まだ刷っていないものを上に、新しい順） */
export async function listLabelUnits(): Promise<LabelUnit[]> {
  return query<LabelUnit>(
    `SELECT u.mgmt_no AS "mgmtNo", s.code AS "skuCode", u.status, u.created_at AS "createdAt",
            u.label_printed_at AS "printedAt"
       FROM core.units u JOIN core.skus s ON s.id = u.sku_id
      WHERE u.label_printed_at IS NULL OR u.label_printed_at > now() - interval '14 days'
      ORDER BY u.label_printed_at IS NOT NULL, u.created_at DESC
      LIMIT 200`,
  );
}

export async function getLabelUnits(mgmtNos: string[]): Promise<LabelUnit[]> {
  if (mgmtNos.length === 0) return [];
  const rows = await query<LabelUnit>(
    `SELECT u.mgmt_no AS "mgmtNo", s.code AS "skuCode", u.status, u.created_at AS "createdAt",
            u.label_printed_at AS "printedAt"
       FROM core.units u JOIN core.skus s ON s.id = u.sku_id
      WHERE u.mgmt_no = ANY($1)`,
    [mgmtNos],
  );
  // 頼まれた順に並べる
  return mgmtNos.flatMap((m) => rows.filter((r) => r.mgmtNo === m));
}

/** 刷った印を付ける（刷り直しても、最後に刷った時刻になる） */
export async function markLabelsPrinted(actorId: number, mgmtNos: string[]): Promise<number> {
  if (mgmtNos.length === 0) return 0;
  const r = await withActor({ kind: "user", userId: actorId }, (client) =>
    client.query(`UPDATE core.units SET label_printed_at = now() WHERE mgmt_no = ANY($1)`, [mgmtNos]),
  );
  return r.rowCount ?? 0;
}
