// 書類の取り込みで使う判定。DBやファイルを使わないので、そのままテストできる。

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 1ファイル20MBまで

export const DOCUMENT_KINDS = [
  "receipt",
  "invoice",
  "delivery_note",
  "warranty_card",
  "quote",
  "setup_guide",
  "photo",
  "rma_form",
  "filing",
  "contract",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export type FileType = { mime: string; ext: "pdf" | "jpg" | "png" | "webp" | "heic" };

/** ファイルの先頭の数バイトから種類を決める（拡張子は信じない）。受け付けない種類なら null */
export function detectFileType(bytes: Uint8Array): FileType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return { mime: "image/png", ext: "png" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (ascii(4, 8) === "ftyp" && ["heic", "heix", "mif1", "msf1", "hevc"].includes(ascii(8, 12))) {
    return { mime: "image/heic", ext: "heic" }; // iPhone の写真
  }
  return null;
}

/** 保存するファイル名。フォルダの部分や制御文字を取り、長すぎれば切る */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "無題").slice(0, 255);
}

const KIND_WORDS: [DocumentKind, RegExp][] = [
  ["warranty_card", /保証書|保証規定|warranty/i],
  ["invoice", /請求書|invoice|ご請求/i],
  ["delivery_note", /納品書|delivery\s*note|packing\s*slip/i],
  ["quote", /見積/i],
  ["receipt", /領収|レシート|receipt|ご利用明細|購入明細/i],
];

/** ファイル名と本文から、書類の種類の見当をつける（人が確かめる前の初期値） */
export function guessKind(fileName: string, text: string, fileType: FileType): DocumentKind {
  for (const [kind, re] of KIND_WORDS) if (re.test(fileName)) return kind;
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  return fileType.mime === "application/pdf" ? "other" : "photo";
}

/** 本文に書いてあるインボイス登録番号（T＋13桁）。同じものは1つにまとめる */
export function findInvoiceRegNos(text: string): string[] {
  const t = text.normalize("NFKC").replace(/(T)[\s-]*(\d{4})[\s-]*(\d{4})[\s-]*(\d{5})/g, "$1$2$3$4");
  return [...new Set(t.match(/T\d{13}(?!\d)/g) ?? [])];
}

function squash(s: string): string {
  return s.normalize("NFKC").toUpperCase().replace(/[\s\-‐‑–—ー−]/g, "");
}

/**
 * 本文に、登録済みの仕入れの注文番号が書いてあるかを探す。
 * 短い番号は別の数字に紛れて見つかってしまうので、5文字以上のものだけ使う。
 */
export function matchOrderNumbers<T extends { orderNo: string }>(text: string, candidates: T[]): T[] {
  const body = squash(text);
  if (body === "") return [];
  return candidates.filter((c) => {
    const no = squash(c.orderNo);
    return no.length >= 5 && body.includes(no);
  });
}

export type DocumentMeta = {
  kind: DocumentKind;
  issuedOn: string | null;
  counterparty: string | null;
  amount: number | null;
  invoiceRegNo: string | null;
};

export type MetaParsed = { ok: true; value: DocumentMeta } | { ok: false; errors: string[] };

/** 書類の項目（日付・取引先・金額など）の入力を確かめる */
export function parseDocumentMeta(raw: {
  kind: unknown;
  issuedOn: unknown;
  counterparty: unknown;
  amount: unknown;
  invoiceRegNo: unknown;
}): MetaParsed {
  const errors: string[] = [];
  const text = (v: unknown) => (typeof v === "string" ? v.normalize("NFKC").trim() : "");

  const kind = DOCUMENT_KINDS.find((k) => k === raw.kind);
  if (!kind) errors.push("書類の種類を選んでください。");

  const issued = text(raw.issuedOn);
  let issuedOn: string | null = null;
  if (issued !== "") {
    const d = new Date(`${issued}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issued) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== issued) {
      errors.push("日付を正しく入れてください。");
    } else issuedOn = issued;
  }

  const counterparty = text(raw.counterparty) || null;
  if (counterparty && counterparty.length > 100) errors.push("取引先が長すぎます（100文字まで）。");

  const amountText = text(raw.amount).replace(/[,円¥\s]/g, "");
  let amount: number | null = null;
  if (amountText !== "") {
    if (!/^\d{1,12}$/.test(amountText)) errors.push("金額は円の数字で入れてください。");
    else amount = Number(amountText);
  }

  const reg = text(raw.invoiceRegNo).toUpperCase().replace(/[\s-]/g, "");
  let invoiceRegNo: string | null = null;
  if (reg !== "") {
    if (!/^T\d{13}$/.test(reg)) errors.push("インボイス登録番号は「T」と13桁の数字です。");
    else invoiceRegNo = reg;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { kind: kind!, issuedOn, counterparty, amount, invoiceRegNo } };
}

/** 確認済みにしてよいか（領収書・請求書は、日付・取引先・金額が要る。電子帳簿保存法で探せるように） */
export function missingForDone(meta: Pick<DocumentMeta, "kind" | "issuedOn" | "counterparty" | "amount">): string[] {
  if (meta.kind !== "receipt" && meta.kind !== "invoice") return [];
  const missing: string[] = [];
  if (!meta.issuedOn) missing.push("日付");
  if (!meta.counterparty) missing.push("取引先");
  if (meta.amount === null) missing.push("金額");
  return missing;
}

/** 取り込みフォルダで読み飛ばすファイル（隠しファイル、書き込み途中のものなど） */
export function skipInInbox(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    /^desktop\.ini$/i.test(name) ||
    /^thumbs\.db$/i.test(name) ||
    /\.(tmp|part|crdownload|download)$/i.test(name)
  );
}
