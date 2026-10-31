import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseError } from "pg";
import { query, withActor } from "@/lib/db";
import {
  MAX_DOCUMENT_BYTES,
  detectFileType,
  findInvoiceRegNos,
  guessKind,
  matchOrderNumbers,
  missingForDone,
  safeFileName,
  skipInInbox,
  type DocumentMeta,
} from "@/lib/document-calc";
import { todayJst } from "@/lib/format";
import { saveFile } from "@/lib/storage";

// 書類（領収書・保証書・納品書など）の取り込みと整理。
// 取り込んだファイルは書き換えも削除もしない。直せるのは日付・取引先・金額などの項目だけ（履歴は監査ログ）。
// actorId は、呼ぶ側（app/documents/actions.ts）が requireDocuments でログインから決めたものを渡す。

export type IntakeResult =
  | { status: "added"; id: number; name: string; linkedPurchaseId: number | null }
  | { status: "duplicate"; id: number; name: string }
  | { status: "rejected"; name: string; reason: string };

/** PDF の文字を取り出す（文字のないPDF＝スキャンの画像だけのものは空になる） */
async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch {
    return "";
  }
}

/**
 * ファイルを1つ取り込む。
 * 種類を中身で確かめ、同じ中身なら二重に入れない。PDF の本文に登録済みの注文番号があれば、その仕入れにひもづける。
 * 日付・金額などは、人が確かめるか、あとでローカルLLMが読む（要確認のまま残す）。
 */
export async function intakeFile(
  actorId: number,
  file: { bytes: Uint8Array; name: string; source: "upload" | "folder" | "scan" },
  linkPurchaseId: number | null = null,
): Promise<IntakeResult> {
  const name = safeFileName(file.name);
  if (file.bytes.byteLength === 0) return { status: "rejected", name, reason: "空のファイルです。" };
  if (file.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { status: "rejected", name, reason: "20MBより大きいファイルは取り込めません。" };
  }
  const type = detectFileType(file.bytes);
  if (!type) return { status: "rejected", name, reason: "PDFか写真（JPEG・PNG・WebP・HEIC）だけ取り込めます。" };

  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const [dup] = await query<{ id: number }>(`SELECT id FROM core.documents WHERE sha256 = $1`, [sha256]);
  if (dup) {
    if (linkPurchaseId) await linkToPurchase(actorId, dup.id, linkPurchaseId);
    return { status: "duplicate", id: dup.id, name };
  }

  const text = type.mime === "application/pdf" ? await pdfText(file.bytes) : "";
  const kind = guessKind(name, text, type);
  const invoiceRegNo = findInvoiceRegNos(text);

  // 本文に注文番号が1件だけ見つかれば、その仕入れにひもづける
  let purchase: { id: number; supplier: string } | null = null;
  if (linkPurchaseId) {
    const [p] = await query<{ id: number; supplier: string }>(
      `SELECT p.id, s.name AS supplier FROM core.purchases p JOIN core.suppliers s ON s.id = p.supplier_id WHERE p.id = $1`,
      [linkPurchaseId],
    );
    purchase = p ?? null;
  } else if (text) {
    const candidates = await query<{ id: number; orderNo: string; supplier: string }>(
      `SELECT p.id, p.supplier_order_no AS "orderNo", s.name AS supplier
         FROM core.purchases p JOIN core.suppliers s ON s.id = p.supplier_id
        WHERE p.supplier_order_no IS NOT NULL AND p.status <> 'cancelled'
          AND p.ordered_on > $1::date - 400`,
      [todayJst()],
    );
    const hits = matchOrderNumbers(text, candidates);
    if (hits.length === 1) purchase = hits[0];
  }

  const uri = await saveFile(file.bytes, sha256, type.ext);
  try {
    const id = await withActor({ kind: "user", userId: actorId }, async (client) => {
      const r = await client.query<{ id: number }>(
        `INSERT INTO core.documents (kind, storage_uri, sha256, mime_type, byte_size, source, original_name,
                                     counterparty, invoice_reg_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          kind,
          uri,
          sha256,
          type.mime,
          file.bytes.byteLength,
          file.source,
          name,
          purchase?.supplier ?? null,
          invoiceRegNo.length === 1 ? invoiceRegNo[0] : null,
        ],
      );
      const docId = r.rows[0].id;
      if (purchase) {
        await client.query(
          `INSERT INTO core.document_links (document_id, entity_type, entity_id) VALUES ($1, 'purchase', $2)`,
          [docId, purchase.id],
        );
      }
      // 日付・金額などは、事務所のローカルLLMがあとで読む（個人情報が入りうるので外には出さない: ルール3）
      await client.query(
        `INSERT INTO core.ai_jobs (kind, route, subject_type, subject_id) VALUES ('read_document', 'local', 'document', $1)`,
        [docId],
      );
      return docId;
    });
    return { status: "added", id, name, linkedPurchaseId: purchase?.id ?? null };
  } catch (error) {
    // 同じファイルを同時に取り込んだとき
    if (error instanceof DatabaseError && error.code === "23505" && error.constraint === "documents_sha256_uq") {
      const [d] = await query<{ id: number }>(`SELECT id FROM core.documents WHERE sha256 = $1`, [sha256]);
      return { status: "duplicate", id: d.id, name };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------
// 共有の取り込みフォルダ
// ---------------------------------------------------------------------

export function inboxDir(): string | null {
  return process.env.ZB_INBOX_DIR || null;
}

export type InboxSummary = { found: number; results: IntakeResult[]; skipped: number; error?: string };

const DONE_DIR = "取り込み済み";
const FAILED_DIR = "取り込めなかった";
const MAX_PER_RUN = 50;

async function moveAside(dir: string, sub: string, name: string): Promise<void> {
  const target = join(/*turbopackIgnore: true*/ dir, sub);
  await mkdir(/*turbopackIgnore: true*/ target, { recursive: true });
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 0; i < 100; i++) {
    const candidate = join(/*turbopackIgnore: true*/ target, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await stat(/*turbopackIgnore: true*/ candidate);
    } catch {
      await rename(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name), candidate);
      return;
    }
  }
}

/**
 * 取り込みフォルダにあるファイルを取り込む。
 * 取り込んだら「取り込み済み/年-月」へ、取り込めなければ「取り込めなかった」へ移す（消さない）。
 * スキャナーが書いている途中かもしれないので、10秒以内に変わったファイルは次の回にまわす。
 */
export async function importInbox(actorId: number, now = Date.now()): Promise<InboxSummary> {
  const dir = inboxDir();
  if (!dir)
    return { found: 0, results: [], skipped: 0, error: "取り込みフォルダ（ZB_INBOX_DIR）が設定されていません。" };
  let names: string[];
  try {
    const entries = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && !skipInInbox(e.name)).map((e) => e.name);
  } catch {
    return { found: 0, results: [], skipped: 0, error: `取り込みフォルダが開けません: ${dir}` };
  }

  const results: IntakeResult[] = [];
  let skipped = 0;
  const month = todayJst().slice(0, 7);
  for (const name of names.sort().slice(0, MAX_PER_RUN)) {
    const path = join(/*turbopackIgnore: true*/ dir, name);
    const info = await stat(/*turbopackIgnore: true*/ path);
    if (now - info.mtimeMs < 10_000) {
      skipped++;
      continue;
    }
    const r = await intakeFile(actorId, {
      bytes: await readFile(/*turbopackIgnore: true*/ path),
      name,
      source: "folder",
    });
    results.push(r);
    await moveAside(dir, r.status === "rejected" ? FAILED_DIR : join(/*turbopackIgnore: true*/ DONE_DIR, month), name);
  }
  return { found: names.length, results, skipped };
}

// ---------------------------------------------------------------------
// 一覧と1件
// ---------------------------------------------------------------------

export type DocumentRow = {
  id: number;
  kind: string;
  originalName: string | null;
  source: string;
  receivedAt: Date;
  issuedOn: string | null;
  counterparty: string | null;
  amount: number | null;
  reviewStatus: string;
  purchases: number[];
};

export async function listDocuments(filter: "needs_review" | "all", limit = 200): Promise<DocumentRow[]> {
  return query<DocumentRow>(
    `SELECT d.id, d.kind, d.original_name AS "originalName", d.source, d.received_at AS "receivedAt",
            d.issued_on AS "issuedOn", d.counterparty, d.amount, d.review_status AS "reviewStatus",
            coalesce(ARRAY(SELECT l.entity_id FROM core.document_links l
                            WHERE l.document_id = d.id AND l.entity_type = 'purchase' ORDER BY l.entity_id), '{}') AS purchases
       FROM core.documents d
      WHERE $1 = 'all' OR d.review_status = 'needs_review'
      ORDER BY d.received_at DESC, d.id DESC
      LIMIT $2`,
    [filter, limit],
  );
}

export type DocumentView = DocumentRow & {
  mimeType: string;
  byteSize: number;
  invoiceRegNo: string | null;
  linkedPurchases: { id: number; supplier: string; orderNo: string | null; orderedOn: string }[];
};

export async function getDocument(id: number): Promise<DocumentView | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [d] = await query<Omit<DocumentView, "linkedPurchases" | "purchases">>(
    `SELECT id, kind, original_name AS "originalName", source, received_at AS "receivedAt", issued_on AS "issuedOn",
            counterparty, amount, review_status AS "reviewStatus", mime_type AS "mimeType", byte_size AS "byteSize",
            invoice_reg_no AS "invoiceRegNo"
       FROM core.documents WHERE id = $1`,
    [id],
  );
  if (!d) return null;
  const linkedPurchases = await query<DocumentView["linkedPurchases"][number]>(
    `SELECT p.id, s.name AS supplier, p.supplier_order_no AS "orderNo", p.ordered_on AS "orderedOn"
       FROM core.document_links l
       JOIN core.purchases p ON p.id = l.entity_id
       JOIN core.suppliers s ON s.id = p.supplier_id
      WHERE l.document_id = $1 AND l.entity_type = 'purchase'
      ORDER BY p.id`,
    [id],
  );
  return { ...d, purchases: linkedPurchases.map((p) => p.id), linkedPurchases };
}

/** 表示・ダウンロード用（保存先は DB にあるものだけ使う） */
export async function getDocumentFileInfo(
  id: number,
): Promise<{ storageUri: string; mimeType: string; originalName: string | null } | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [d] = await query<{ storageUri: string; mimeType: string; originalName: string | null }>(
    `SELECT storage_uri AS "storageUri", mime_type AS "mimeType", original_name AS "originalName"
       FROM core.documents WHERE id = $1`,
    [id],
  );
  return d ?? null;
}

export type DocResult = { ok: true; message: string } | { ok: false; message: string };

/** 日付・取引先・金額などを直す。done なら確認済みにする（領収書・請求書は3つそろっていること） */
export async function updateDocumentMeta(
  actorId: number,
  id: number,
  meta: DocumentMeta,
  done: boolean,
): Promise<DocResult> {
  if (done) {
    const missing = missingForDone(meta);
    if (missing.length > 0)
      return {
        ok: false,
        message: `確認済みにするには、${missing.join(/*turbopackIgnore: true*/ "・")}を入れてください。`,
      };
  }
  const r = await withActor({ kind: "user", userId: actorId }, (client) =>
    client.query(
      `UPDATE core.documents
          SET kind = $2, issued_on = $3, counterparty = $4, amount = $5, invoice_reg_no = $6, review_status = $7
        WHERE id = $1`,
      [id, meta.kind, meta.issuedOn, meta.counterparty, meta.amount, meta.invoiceRegNo, done ? "done" : "needs_review"],
    ),
  );
  if (r.rowCount !== 1) return { ok: false, message: "その書類はありません。" };
  return { ok: true, message: done ? "確認済みにしました。" : "保存しました（要確認のまま）。" };
}

/** 書類を仕入れにひもづける */
export async function linkToPurchase(actorId: number, documentId: number, purchaseId: number): Promise<DocResult> {
  if (!Number.isSafeInteger(purchaseId) || purchaseId <= 0) return { ok: false, message: "仕入れを選んでください。" };
  const r = await withActor({ kind: "user", userId: actorId }, (client) =>
    client.query(
      `INSERT INTO core.document_links (document_id, entity_type, entity_id)
       SELECT d.id, 'purchase', p.id FROM core.documents d, core.purchases p WHERE d.id = $1 AND p.id = $2
       ON CONFLICT DO NOTHING`,
      [documentId, purchaseId],
    ),
  );
  return r.rowCount === 1
    ? { ok: true, message: `仕入れ #${purchaseId} にひもづけました。` }
    : { ok: false, message: "ひもづけられませんでした（もうひもづいているか、仕入れがありません）。" };
}

export async function unlinkFromPurchase(actorId: number, documentId: number, purchaseId: number): Promise<DocResult> {
  const r = await withActor({ kind: "user", userId: actorId }, (client) =>
    client.query(
      `DELETE FROM core.document_links WHERE document_id = $1 AND entity_type = 'purchase' AND entity_id = $2`,
      [documentId, purchaseId],
    ),
  );
  return r.rowCount === 1
    ? { ok: true, message: "ひもづけを外しました。" }
    : { ok: false, message: "ひもづいていません。" };
}

/** 仕入れにひもづいた書類 */
export async function documentsForPurchase(purchaseId: number): Promise<DocumentRow[]> {
  return query<DocumentRow>(
    `SELECT d.id, d.kind, d.original_name AS "originalName", d.source, d.received_at AS "receivedAt",
            d.issued_on AS "issuedOn", d.counterparty, d.amount, d.review_status AS "reviewStatus",
            ARRAY[$1::bigint] AS purchases
       FROM core.document_links l JOIN core.documents d ON d.id = l.document_id
      WHERE l.entity_type = 'purchase' AND l.entity_id = $1
      ORDER BY d.received_at`,
    [purchaseId],
  );
}

/** ひもづけ先の候補（最近の仕入れ） */
export async function recentPurchaseOptions(): Promise<{ id: number; label: string }[]> {
  const rows = await query<{ id: number; supplier: string; orderNo: string | null; orderedOn: string }>(
    `SELECT p.id, s.name AS supplier, p.supplier_order_no AS "orderNo", p.ordered_on AS "orderedOn"
       FROM core.purchases p JOIN core.suppliers s ON s.id = p.supplier_id
      WHERE p.status <> 'cancelled'
      ORDER BY p.ordered_on DESC, p.id DESC LIMIT 100`,
  );
  return rows.map((r) => ({ id: r.id, label: `${r.orderedOn} ${r.supplier} ${r.orderNo ?? ""}`.trim() }));
}
