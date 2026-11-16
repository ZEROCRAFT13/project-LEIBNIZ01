// 自社出荷（FBM）の入力の確かめ。DBを使わないので、そのままテストできる。

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type FbmStatus = "open" | "shipped" | "delivered" | "cancelled" | "returned";

export const fbmStatusLabel: Record<FbmStatus, string> = {
  open: "出荷待ち",
  shipped: "発送済み",
  delivered: "配達済み",
  cancelled: "取り消し",
  returned: "返品",
};

/** Amazon の注文番号（例 503-1234567-1234567）。全角・空白・ハイフンのゆれを直す */
export function normalizeAmazonOrderNo(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[‐‑‒–—―ー−]/g, "-")
    .replace(/\s+/g, "");
}

export function isAmazonOrderNo(v: string): boolean {
  return /^\d{3}-\d{7}-\d{7}$/.test(v);
}

export type FbmOrderInput = {
  orderNo: string;
  orderedAt: Date;
  shipBy: string | null; // YYYY-MM-DD
  skuId: number;
  qty: number;
  /** 注文の合計（税込・円）。1台あたりは合計を数で割った額（割り切れないときは登録しない） */
  totalAmount: number;
  note: string | null;
};

const str = (raw: Record<string, unknown>, k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");

/**
 * 自社出荷の注文を手で登録するときの入力（SP-API の取り込みができるまで）。
 * orderedAt は「YYYY-MM-DDTHH:mm」（日本時間）。now は今の時刻（未来の注文日時を止めるため）
 */
export function parseFbmOrderInput(raw: Record<string, unknown>, now: Date): Parsed<FbmOrderInput> {
  const errors: string[] = [];
  const orderNo = normalizeAmazonOrderNo(str(raw, "orderNo"));
  if (!isAmazonOrderNo(orderNo)) errors.push("注文番号は「3けた-7けた-7けた」の数字です（例 503-1234567-1234567）。");

  const at = str(raw, "orderedAt").normalize("NFKC").trim();
  let orderedAt = new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) orderedAt = new Date(`${at}:00+09:00`);
  if (Number.isNaN(orderedAt.getTime())) errors.push("注文日時を入れてください。");
  else if (orderedAt.getTime() > now.getTime() + 5 * 60_000) errors.push("注文日時が未来になっています。");

  const sb = str(raw, "shipBy").normalize("NFKC").trim();
  let shipBy: string | null = null;
  if (sb !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sb) || Number.isNaN(new Date(`${sb}T00:00:00+09:00`).getTime())) {
      errors.push("出荷期限は日付で入れてください。");
    } else shipBy = sb;
  }

  const skuId = Number(str(raw, "skuId"));
  if (!Number.isSafeInteger(skuId) || skuId <= 0) errors.push("機種を選んでください。");

  const q = str(raw, "qty").normalize("NFKC").trim();
  const qty = /^\d{1,2}$/.test(q) ? Number(q) : NaN;
  if (!(qty >= 1 && qty <= 10)) errors.push("数は1〜10台で入れてください。");

  const t = str(raw, "totalAmount").normalize("NFKC").replace(/[,\s円¥]/g, "");
  const totalAmount = /^\d{1,9}$/.test(t) ? Number(t) : NaN;
  if (Number.isNaN(totalAmount)) errors.push("注文の合計（税込）を円の数字で入れてください。");
  else if (qty >= 1 && totalAmount % qty !== 0) {
    errors.push("合計が数で割り切れません。1台あたりの金額が分かるように、注文の合計をそのまま入れてください。");
  }

  const note = str(raw, "note").normalize("NFC").trim();
  if (note.length > 500) errors.push("メモは500文字までにしてください。");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { orderNo, orderedAt, shipBy, skuId, qty, totalAmount, note: note || null } };
}

/** 発送する前に足りないもの */
export function missingForFbmShip(o: {
  qty: number;
  linked: number;
  withoutTracking: number;
  carrier: string | null;
}): string[] {
  const m: string[] = [];
  if (o.linked < o.qty) m.push(`個体があと ${o.qty - o.linked}台 足りません（管理番号を読んでください）`);
  if (o.withoutTracking > 0) m.push(`送り状番号が入っていない箱が ${o.withoutTracking}つ あります`);
  if (!o.carrier) m.push("運送会社を選んでください");
  return m;
}

// ---------------------------------------------------------------------
// Amazon への出荷通知（SP-API confirmShipment）の中身を組み立てる
// ---------------------------------------------------------------------

/**
 * 運送会社 → Amazon の配送業者コード（大文字・小文字も含めて決まった値）。
 * ここにない運送会社（西濃・Amazon・その他）は、この画面からは送らず、セラーセントラルで人が通知する
 */
export const AMAZON_CARRIER_CODES: Partial<Record<string, string>> = {
  yamato: "Yamato Transport",
  sagawa: "Sagawa Express",
  japanpost: "Japan Post",
};

/** 結びついた個体1台（箱）。送り状番号ごとに1つの箱としてまとめる */
export type ShipUnit = { mgmtNo: string; skuId: number; trackingNo: string | null };
/** Amazon の注文の明細（skuId は出品のセラー SKU から引いたもの。未登録なら null） */
export type AmazonItem = { orderItemId: string; sellerSku: string; skuId: number | null; quantity: number };

export type ShipPackage = {
  packageReferenceId: string;
  trackingNumber: string;
  mgmtNos: string[];
  orderItems: { orderItemId: string; quantity: number }[];
};

/**
 * 箱（送り状番号）ごとに、Amazon の注文の明細のどれを何個入れたかを決める。
 * このシステムの記録と Amazon の注文が、機種ごとの数でぴったり合わなければ送らない（まちがった通知を出さないため）。
 * 箱の番号（packageReferenceId）は、送り状番号が最初に出てきた順に 1, 2, … 。同じ注文なら何度作っても同じになるので、
 * 送り直したときは Amazon 側で同じ箱の内容が直る
 */
export function buildShipPackages(units: ShipUnit[], items: AmazonItem[]): { ok: true; packages: ShipPackage[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const unknown = items.filter((i) => i.skuId === null && i.quantity > 0);
  for (const i of unknown) errors.push(`Amazon の注文の出品（${i.sellerSku}）が、このシステムの機種に登録されていません。`);
  if (units.some((u) => !u.trackingNo)) errors.push("送り状番号が入っていない箱があります。");
  const want = new Map<number, number>();
  for (const i of items) if (i.skuId !== null && i.quantity > 0) want.set(i.skuId, (want.get(i.skuId) ?? 0) + i.quantity);
  const have = new Map<number, number>();
  for (const u of units) have.set(u.skuId, (have.get(u.skuId) ?? 0) + 1);
  for (const id of new Set([...want.keys(), ...have.keys()])) {
    if ((want.get(id) ?? 0) !== (have.get(id) ?? 0)) {
      errors.push(`Amazon の注文の数（${want.get(id) ?? 0}台）と、結びついた個体の数（${have.get(id) ?? 0}台）が合わない機種があります。`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 明細ごとの残り（同じ機種の明細が2つあっても、上から順に詰める）
  const remaining = items.filter((i) => i.quantity > 0).map((i) => ({ ...i, left: i.quantity }));
  const order: string[] = [];
  const byTracking = new Map<string, ShipUnit[]>();
  for (const u of units) {
    const t = u.trackingNo as string;
    if (!byTracking.has(t)) {
      byTracking.set(t, []);
      order.push(t);
    }
    byTracking.get(t)!.push(u);
  }
  const packages = order.map((t, index) => {
    const counts = new Map<string, number>();
    for (const u of byTracking.get(t)!) {
      const item = remaining.find((i) => i.skuId === u.skuId && i.left > 0)!;
      item.left -= 1;
      counts.set(item.orderItemId, (counts.get(item.orderItemId) ?? 0) + 1);
    }
    return {
      packageReferenceId: String(index + 1),
      trackingNumber: t,
      mgmtNos: byTracking.get(t)!.map((u) => u.mgmtNo),
      orderItems: [...counts].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
    };
  });
  return { ok: true, packages };
}
