// 書類の取り込みの判定（ファイルの種類、注文番号・インボイス番号の見つけ方、項目の確かめ）
import { describe, expect, it } from "vitest";
import { fakeJpeg, makePdf } from "@/test/make-pdf";
import {
  detectFileType,
  findInvoiceRegNos,
  guessKind,
  matchOrderNumbers,
  missingForDone,
  parseDocumentMeta,
  safeFileName,
  skipInInbox,
} from "./document-calc";

describe("ファイルの種類は中身で決める", () => {
  it("PDF・JPEG・PNG・WebP・HEIC を見分ける", () => {
    expect(detectFileType(makePdf(["x"]))).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(detectFileType(fakeJpeg(1))).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(detectFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({ mime: "image/png", ext: "png" });
    expect(detectFileType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ mime: "image/webp", ext: "webp" });
    expect(detectFileType(new TextEncoder().encode("\0\0\0\x18ftypheic\0\0"))).toEqual({ mime: "image/heic", ext: "heic" });
  });

  it("拡張子を .pdf にしただけのファイルや、HTML・実行ファイルは受け付けない", () => {
    expect(detectFileType(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(detectFileType(new TextEncoder().encode("MZ\x90\0"))).toBeNull();
    expect(detectFileType(new Uint8Array([]))).toBeNull();
  });
});

describe("ファイル名", () => {
  it.each([
    ["C:\\Users\\a\\Downloads\\領収書.pdf", "領収書.pdf"],
    ["../../etc/passwd", "passwd"],
    ["a\u0000b.pdf", "ab.pdf"],
    ["   ", "無題"],
  ])("%s → %s", (raw, expected) => {
    expect(safeFileName(raw)).toBe(expected);
  });

  it("Mac の濁点が分かれた名前もそろえる", () => {
    expect(safeFileName("ﾄﾞｽﾊﾟﾗ".normalize("NFD"))).toBe("ﾄﾞｽﾊﾟﾗ".normalize("NFC"));
  });
});

describe("書類の種類の見当", () => {
  const pdf = { mime: "application/pdf", ext: "pdf" } as const;
  const jpg = { mime: "image/jpeg", ext: "jpg" } as const;
  it.each([
    ["領収書_EC0039.pdf", "", pdf, "receipt"],
    ["保証書.jpg", "", jpg, "warranty_card"],
    ["scan001.pdf", "納品書 ご注文番号", pdf, "delivery_note"],
    ["invoice-123.pdf", "", pdf, "invoice"],
    ["scan002.pdf", "", pdf, "other"],
    ["IMG_0001.jpg", "", jpg, "photo"],
  ] as const)("%s（本文:%s）→ %s", (name, text, type, kind) => {
    expect(guessKind(name, text, type)).toBe(kind);
  });
});

describe("本文から番号を見つける", () => {
  it("インボイス登録番号（区切りや全角があってもそろえる）", () => {
    expect(findInvoiceRegNos("登録番号：T1234567890123")).toEqual(["T1234567890123"]);
    expect(findInvoiceRegNos("Ｔ１２３４５６７８９０１２３ / T-1234-5678-90123")).toEqual(["T1234567890123"]);
    expect(findInvoiceRegNos("T12345678901234（14桁）")).toEqual([]);
  });

  it("登録済みの注文番号が本文にあるか（ハイフンや空白のちがいは気にしない）", () => {
    const candidates = [
      { id: 1, orderNo: "EC0039291377" },
      { id: 2, orderNo: "249-3017723-9998265" },
      { id: 3, orderNo: "123" }, // 短すぎる番号は使わない
    ];
    expect(matchOrderNumbers("ご注文番号 EC0039291377", candidates).map((c) => c.id)).toEqual([1]);
    expect(matchOrderNumbers("注文番号 249 3017723 9998265", candidates).map((c) => c.id)).toEqual([2]);
    expect(matchOrderNumbers("合計 1,234円", candidates)).toEqual([]);
    expect(matchOrderNumbers("", candidates)).toEqual([]);
  });
});

describe("書類の項目", () => {
  const good = { kind: "receipt", issuedOn: "2026-10-30", counterparty: " ドスパラ ", amount: "¥279,900", invoiceRegNo: "t-1234567890123" };

  it("正しい入力をそろえる", () => {
    expect(parseDocumentMeta(good)).toEqual({
      ok: true,
      value: { kind: "receipt", issuedOn: "2026-10-30", counterparty: "ドスパラ", amount: 279900, invoiceRegNo: "T1234567890123" },
    });
  });

  it("空の項目は null", () => {
    expect(parseDocumentMeta({ kind: "warranty_card", issuedOn: "", counterparty: "", amount: "", invoiceRegNo: "" })).toEqual({
      ok: true,
      value: { kind: "warranty_card", issuedOn: null, counterparty: null, amount: null, invoiceRegNo: null },
    });
  });

  it.each([
    [{ kind: "virus" }, "書類の種類を選んでください。"],
    [{ issuedOn: "2026-02-30" }, "日付を正しく入れてください。"],
    [{ amount: "-100" }, "金額は円の数字で入れてください。"],
    [{ amount: "12.5" }, "金額は円の数字で入れてください。"],
    [{ invoiceRegNo: "T123" }, "インボイス登録番号は「T」と13桁の数字です。"],
  ])("%o → 「%s」", (patch, message) => {
    const r = parseDocumentMeta({ ...good, ...patch });
    expect(!r.ok && r.errors).toContain(message);
  });

  it("領収書・請求書は、日付・取引先・金額がそろわないと確認済みにできない（ほかの書類は要らない）", () => {
    expect(missingForDone({ kind: "receipt", issuedOn: null, counterparty: "A", amount: null })).toEqual(["日付", "金額"]);
    expect(missingForDone({ kind: "invoice", issuedOn: "2026-10-01", counterparty: "A", amount: 0 })).toEqual([]);
    expect(missingForDone({ kind: "warranty_card", issuedOn: null, counterparty: null, amount: null })).toEqual([]);
  });
});

describe("取り込みフォルダで読み飛ばすファイル", () => {
  it.each([
    [".DS_Store", true],
    ["desktop.ini", true],
    ["~$memo.docx", true],
    ["scan.pdf.crdownload", true],
    ["scan.tmp", true],
    ["領収書.pdf", false],
  ])("%s → %s", (name, skip) => {
    expect(skipInInbox(name)).toBe(skip);
  });
});
