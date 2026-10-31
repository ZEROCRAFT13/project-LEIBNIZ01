// FBA 納品の入力の確かめと、機種ごとの台数の集計。DBを使わないので、そのままテストできる。

export type FbaStatus = "draft" | "shipped" | "receiving" | "closed" | "cancelled";

export const fbaStatusLabel: Record<FbaStatus, string> = {
  draft: "下書き",
  shipped: "発送済み",
  receiving: "受領中",
  closed: "完了",
  cancelled: "取り消し",
};

export const FBA_CARRIERS = ["yamato", "sagawa", "japanpost", "seino", "amazon", "other"] as const;
export type FbaCarrier = (typeof FBA_CARRIERS)[number];

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Amazon の出荷の番号（例 FBA15ABCD1234）。全角・小文字・空白を直す */
export function normalizeAmazonShipmentId(raw: string): string {
  return raw.normalize("NFKC").toUpperCase().replace(/\s+/g, "");
}

export function isAmazonShipmentId(v: string): boolean {
  return /^FBA[0-9A-Z]{6,12}$/.test(v);
}

/** 送り状番号（数字とハイフン。読み取り機で読んでも、手で打ってもよい） */
export function normalizeTracking(raw: string): string {
  return raw.normalize("NFKC").toUpperCase().replace(/[\s‐‑‒–—―ー−]/g, (c) => (/\s/.test(c) ? "" : "-"));
}

export function isTracking(v: string): boolean {
  return /^[0-9A-Z-]{6,30}$/.test(v);
}

export type ShipmentInfo = {
  amazonShipmentId: string | null;
  destinationFc: string | null;
  carrier: FbaCarrier | null;
  note: string | null;
};

/** 納品の見出し（Amazon の番号・納品先の倉庫・運送会社・メモ）。下書きのうちは空でもよい */
export function parseShipmentInfo(raw: Record<string, unknown>): Parsed<ShipmentInfo> {
  const errors: string[] = [];
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const id = normalizeAmazonShipmentId(str("amazonShipmentId"));
  if (id !== "" && !isAmazonShipmentId(id)) {
    errors.push("Amazon の出荷の番号は「FBA」で始まる英数字です（例 FBA15ABCD1234）。");
  }
  const fc = str("destinationFc").normalize("NFKC").toUpperCase().trim();
  if (fc !== "" && !/^[A-Z0-9]{3,5}$/.test(fc)) errors.push("納品先の倉庫は英数字3〜5文字です（例 NRT5）。");
  const c = str("carrier");
  const carrier = (FBA_CARRIERS as readonly string[]).includes(c) ? (c as FbaCarrier) : null;
  if (c !== "" && !carrier) errors.push("運送会社を選び直してください。");
  const note = str("note").normalize("NFC").trim();
  if (note.length > 500) errors.push("メモは500文字までにしてください。");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { amazonShipmentId: id || null, destinationFc: fc || null, carrier, note: note || null },
  };
}

/** 発送する前に足りないもの（発送のボタンの横に出す） */
export function missingForShip(s: { amazonShipmentId: string | null; unitCount: number; notReady: number }): string[] {
  const m: string[] = [];
  if (s.unitCount === 0) m.push("個体が1台も入っていません");
  if (!s.amazonShipmentId) m.push("Amazon の出荷の番号（FBA15…）が入っていません");
  if (s.notReady > 0) m.push(`出荷待ちでない個体が ${s.notReady}台 入っています`);
  return m;
}

export type SkuCount = { skuId: number; skuCode: string; sent: number; received: number };

/** 機種ごとの送った台数と受領数 */
export function summarizeBySku(
  units: { skuId: number; skuCode: string }[],
  receipts: { skuId: number; receivedQty: number }[],
): { rows: SkuCount[]; sent: number; received: number; allReceived: boolean } {
  const map = new Map<number, SkuCount>();
  for (const u of units) {
    const row = map.get(u.skuId) ?? { skuId: u.skuId, skuCode: u.skuCode, sent: 0, received: 0 };
    row.sent += 1;
    map.set(u.skuId, row);
  }
  for (const r of receipts) {
    const row = map.get(r.skuId);
    if (row) row.received = r.receivedQty;
  }
  const rows = [...map.values()].sort((a, b) => a.skuCode.localeCompare(b.skuCode));
  const sent = rows.reduce((n, r) => n + r.sent, 0);
  const received = rows.reduce((n, r) => n + Math.min(r.received, r.sent), 0);
  return { rows, sent, received, allReceived: rows.length > 0 && rows.every((r) => r.received >= r.sent) };
}

/** 受領数の入力（機種ごと）。0〜送った台数の整数 */
export function parseReceipts(
  raw: Record<string, unknown>,
  rows: SkuCount[],
): Parsed<{ skuId: number; receivedQty: number }[]> {
  const errors: string[] = [];
  const out: { skuId: number; receivedQty: number }[] = [];
  for (const r of rows) {
    const v = raw[`received_${r.skuId}`];
    const t = typeof v === "string" ? v.normalize("NFKC").trim() : "";
    if (t === "") continue;
    if (!/^\d{1,4}$/.test(t)) {
      errors.push(`${r.skuCode} の受領数は数字で入れてください。`);
      continue;
    }
    const n = Number(t);
    if (n > r.sent) errors.push(`${r.skuCode} の受領数（${n}）が、送った台数（${r.sent}）より多くなっています。`);
    else out.push({ skuId: r.skuId, receivedQty: n });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}
