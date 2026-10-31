// 書類の取り込みのテスト。ダミーデータのDBと、一時フォルダ（保存先・取り込みフォルダ）を使う
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, query } from "@/lib/db";
import { parsePurchaseInput } from "@/lib/purchase-calc";
import { createPurchase } from "@/lib/purchasing";
import { fakeJpeg, makePdf } from "@/test/make-pdf";
import {
  documentsForPurchase,
  getDocument,
  importInbox,
  intakeFile,
  linkToPurchase,
  listDocuments,
  unlinkFromPurchase,
  updateDocumentMeta,
} from "./documents";
import { loadFile } from "./storage";

let tmp: string;
let inbox: string;
let owner: number;
let purchaseId: number;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "zb-docs-"));
  inbox = join(tmp, "inbox");
  await mkdir(inbox);
  process.env.ZB_STORAGE_DIR = join(tmp, "storage");
  process.env.ZB_INBOX_DIR = inbox;
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  const supplierId = (await query<{ id: number }>("SELECT id FROM core.suppliers WHERE name = 'ドスパラ'"))[0].id;
  const modelId = (await query<{ id: number }>("SELECT id FROM core.part_models WHERE model_no = 'B850-ATX'"))[0].id;
  const parsed = parsePurchaseInput(
    {
      supplierId: String(supplierId),
      orderNo: "EC0000012345",
      orderedOn: "2026-10-28",
      paymentMethod: "card",
      tax: "",
      lines: [{ partModelId: String(modelId), description: "", qty: "1", unitPrice: "24980" }],
    },
    "2026-11-01",
  );
  if (!parsed.ok) throw new Error(parsed.errors.join());
  purchaseId = await createPurchase(owner, parsed.value);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  await getPool().end();
});

describe("ファイルを取り込む", () => {
  let receiptId: number;

  it("PDFの本文に登録済みの注文番号があれば、その仕入れにひもづけ、取引先とインボイス番号も入れる", async () => {
    const pdf = makePdf(["DUMMY RECEIPT", "Order No. EC0000012345", "Registration T1234567890123", "Total 24,980 JPY"]);
    const r = await intakeFile(owner, { bytes: pdf, name: "領収書_dospara.pdf", source: "upload" });
    expect(r).toMatchObject({ status: "added", linkedPurchaseId: purchaseId });
    if (r.status !== "added") throw new Error();
    receiptId = r.id;

    const d = await getDocument(receiptId);
    expect(d).toMatchObject({
      kind: "receipt",
      source: "upload",
      originalName: "領収書_dospara.pdf",
      mimeType: "application/pdf",
      counterparty: "ドスパラ",
      invoiceRegNo: "T1234567890123",
      reviewStatus: "needs_review",
      issuedOn: null,
      amount: null,
    });
    expect(d?.linkedPurchases.map((p) => p.id)).toEqual([purchaseId]);
    // ファイルは中身のハッシュの名前で保存され、そのまま読み戻せる
    const [row] = await query<{ storage_uri: string }>("SELECT storage_uri FROM core.documents WHERE id = $1", [receiptId]);
    expect(row.storage_uri).toMatch(/^local:[0-9a-f]{2}\/[0-9a-f]{64}\.pdf$/);
    expect(new Uint8Array(await loadFile(row.storage_uri))).toEqual(pdf);
    // 日付・金額はローカルLLMがあとで読む（ジョブだけ入る。外のAIには送らない）
    const [job] = await query<{ route: string; status: string }>(
      "SELECT route, status FROM core.ai_jobs WHERE kind = 'read_document' AND subject_id = $1",
      [receiptId],
    );
    expect(job).toEqual({ route: "local", status: "queued" });
  });

  it("同じファイルは二重に取り込まない（名前がちがっても）", async () => {
    const pdf = makePdf(["DUMMY RECEIPT", "Order No. EC0000012345", "Registration T1234567890123", "Total 24,980 JPY"]);
    const r = await intakeFile(owner, { bytes: pdf, name: "コピー.pdf", source: "folder" });
    expect(r).toEqual({ status: "duplicate", id: receiptId, name: "コピー.pdf" });
  });

  it("注文番号が見つからない写真は、ひもづけずに要確認にする", async () => {
    const r = await intakeFile(owner, { bytes: fakeJpeg(7), name: "IMG_0007.jpg", source: "upload" });
    expect(r).toMatchObject({ status: "added", linkedPurchaseId: null });
    if (r.status !== "added") throw new Error();
    expect(await getDocument(r.id)).toMatchObject({ kind: "photo", counterparty: null, linkedPurchases: [] });
  });

  it("仕入れの画面から取り込めば、その仕入れにひもづく", async () => {
    const r = await intakeFile(owner, { bytes: fakeJpeg(8), name: "保証書.jpg", source: "upload" }, purchaseId);
    expect(r).toMatchObject({ status: "added", linkedPurchaseId: purchaseId });
    expect((await documentsForPurchase(purchaseId)).map((d) => d.kind).sort()).toEqual(["receipt", "warranty_card"]);
  });

  it("PDF・写真以外や、空のファイルは断る", async () => {
    expect(await intakeFile(owner, { bytes: new TextEncoder().encode("<html>"), name: "a.pdf", source: "upload" })).toMatchObject({
      status: "rejected",
    });
    expect(await intakeFile(owner, { bytes: new Uint8Array(), name: "b.pdf", source: "upload" })).toMatchObject({
      status: "rejected",
    });
  });
});

describe("項目を入れて確認済みにする", () => {
  it("領収書は日付・取引先・金額がそろうまで確認済みにできない。そろえば確認済み", async () => {
    const [d] = await listDocuments("needs_review").then((rows) => rows.filter((r) => r.kind === "receipt"));
    const meta = { kind: "receipt" as const, issuedOn: null, counterparty: "ドスパラ", amount: null, invoiceRegNo: null };
    expect(await updateDocumentMeta(owner, d.id, meta, true)).toEqual({
      ok: false,
      message: "確認済みにするには、日付・金額を入れてください。",
    });
    expect(await updateDocumentMeta(owner, d.id, { ...meta, issuedOn: "2026-10-28", amount: 24980 }, true)).toMatchObject({
      ok: true,
    });
    expect((await listDocuments("needs_review")).some((r) => r.id === d.id)).toBe(false);
    expect((await listDocuments("all")).find((r) => r.id === d.id)).toMatchObject({
      reviewStatus: "done",
      issuedOn: "2026-10-28",
      amount: 24980,
    });
  });

  it("ひもづけを外して、付け直せる", async () => {
    const [d] = (await documentsForPurchase(purchaseId)).filter((x) => x.kind === "warranty_card");
    expect(await unlinkFromPurchase(owner, d.id, purchaseId)).toMatchObject({ ok: true });
    expect(await unlinkFromPurchase(owner, d.id, purchaseId)).toMatchObject({ ok: false });
    expect(await linkToPurchase(owner, d.id, purchaseId)).toMatchObject({ ok: true });
    expect(await linkToPurchase(owner, d.id, purchaseId)).toMatchObject({ ok: false });
    expect(await linkToPurchase(owner, d.id, 999999)).toMatchObject({ ok: false });
  });
});

describe("共有の取り込みフォルダ", () => {
  it("フォルダのファイルを取り込み、取り込み済み・取り込めなかったへ移す。書き込み途中のものは次の回に", async () => {
    const old = new Date(Date.now() - 60_000);
    const put = async (name: string, bytes: Uint8Array | string, fresh = false) => {
      await writeFile(join(inbox, name), bytes);
      if (!fresh) await utimes(join(inbox, name), old, old);
    };
    await put("scan_0001.pdf", makePdf(["DELIVERY NOTE", "EC0000012345"]));
    await put("保証書_GPU.jpg", fakeJpeg(9));
    await put("memo.txt", "not a document");
    await put("desktop.ini", "[.ShellClassInfo]");
    await put("scan_0002.pdf", makePdf(["still scanning"]), true);

    const r = await importInbox(owner);
    expect(r.found).toBe(4); // desktop.ini は数えない
    expect(r.skipped).toBe(1);
    expect(r.results.map((x) => [x.name, x.status])).toEqual([
      ["memo.txt", "rejected"],
      ["scan_0001.pdf", "added"],
      ["保証書_GPU.jpg", "added"],
    ]);
    const delivery = r.results.find((x) => x.name === "scan_0001.pdf");
    expect(delivery).toMatchObject({ linkedPurchaseId: purchaseId });

    const left = (await readdir(inbox)).sort();
    expect(left).toEqual(["desktop.ini", "scan_0002.pdf", "取り込めなかった", "取り込み済み"].sort());
    expect(await readdir(join(inbox, "取り込めなかった"))).toEqual(["memo.txt"]);
    const [month] = await readdir(join(inbox, "取り込み済み"));
    expect(month).toMatch(/^\d{4}-\d{2}$/);
    expect((await readdir(join(inbox, "取り込み済み", month))).sort()).toEqual(["scan_0001.pdf", "保証書_GPU.jpg"].sort());
  });

  it("取り込み済みと同じ名前のファイルがまた来たら、名前に番号を付けて移す（上書きしない）", async () => {
    await writeFile(join(inbox, "scan_0001.pdf"), makePdf(["another", "file"]));
    await utimes(join(inbox, "scan_0001.pdf"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const r = await importInbox(owner);
    expect(r.results).toHaveLength(1);
    const [month] = await readdir(join(inbox, "取り込み済み"));
    expect(existsSync(join(inbox, "取り込み済み", month, "scan_0001 (1).pdf"))).toBe(true);
  });

  it("フォルダが設定されていなければ、そう伝える", async () => {
    const saved = process.env.ZB_INBOX_DIR;
    delete process.env.ZB_INBOX_DIR;
    expect((await importInbox(owner)).error).toContain("設定されていません");
    process.env.ZB_INBOX_DIR = saved;
  });
});
