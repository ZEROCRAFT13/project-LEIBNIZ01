// ショップの注文確認メールを読んで、仕入れの下書きの項目にする。DBを使わないので、そのままテストできる。
// ショップごとにメールの形が決まっているので、形に合わせて読む（AIは使わない）。
// 金額は読み取ったあとにプログラムで検算し、合わないところは「気になる点」として残す（ルール5）。

import type { PaymentMethod } from "@/lib/purchase-calc";

export type ParsedLine = {
  description: string;
  qty: number;
  /** 税込の単価（メールに書いてあれば） */
  unitPrice: number | null;
  /** 税込の金額（数量×単価） */
  lineTotal: number;
  /** item = 商品、fee = 送料・手数料など */
  kind: "item" | "fee";
};

export type ParsedOrder = {
  parser: string;
  /** core.suppliers の名前 */
  supplierName: string;
  orderNo: string | null;
  orderedOn: string | null;
  paymentMethod: PaymentMethod | null;
  total: number | null;
  lines: ParsedLine[];
  issues: string[];
};

const yenNum = (s: string) => Number(s.replace(/,/g, ""));

function paymentFrom(text: string): PaymentMethod | null {
  if (/カード|card/i.test(text)) return "card";
  if (/振込|振り込み/.test(text)) return "bank";
  if (/代引|代金引換/.test(text)) return "cod";
  if (/現金/.test(text)) return "cash";
  return text.trim() ? "other" : null;
}

/** 明細と合計を検算して、気になる点を足す */
function check(order: ParsedOrder): ParsedOrder {
  const issues = [...order.issues];
  if (!order.orderNo) issues.push("注文番号が読み取れませんでした。");
  if (!order.orderedOn) issues.push("注文日が読み取れませんでした。");
  if (order.lines.filter((l) => l.kind === "item").length === 0) issues.push("商品の明細が読み取れませんでした。");
  order.lines.forEach((l, i) => {
    if (l.unitPrice !== null && l.unitPrice * l.qty !== l.lineTotal) {
      issues.push(`${i + 1}行目：単価×数量（${l.unitPrice}×${l.qty}）が金額（${l.lineTotal}円）と合いません。`);
    }
  });
  const sum = order.lines.reduce((s, l) => s + l.lineTotal, 0);
  if (order.total === null) issues.push("合計金額が読み取れませんでした。");
  else if (sum !== order.total) {
    issues.push(`明細の合計（${sum.toLocaleString()}円）がメールの合計（${order.total.toLocaleString()}円）と合いません。値引きやポイントの行がないか確かめてください。`);
  }
  return { ...order, issues };
}

// ---------------------------------------------------------------------
// ドスパラ（「ドスパラWEBサイトより -ご注文確定のお知らせ-」）
//   【ご注文番号】 EC0000000000
//   【受注日】 2026/10/30
//   【お支払方法】 ○○カード 1回
//   【ご注文明細】
//   1 商品名
//   単価：7,480円 数量：30個 金額：224,400円
//   税込金額： 279,900円
// ---------------------------------------------------------------------
function parseDospara(text: string): ParsedOrder | null {
  if (!/ドスパラ|dospara/i.test(text) || !/【ご注文番号】/.test(text)) return null;

  const orderNo = text.match(/【ご注文番号】\s*([A-Z0-9-]{5,30})/)?.[1] ?? null;
  const d = text.match(/【受注日】\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const orderedOn = d ? `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}` : null;
  const payment = text.match(/【お支払方法】\s*([^\n]*)/)?.[1] ?? "";

  const lines: ParsedLine[] = [];
  const rows = text.split("\n").map((r) => r.trim());
  const start = rows.findIndex((r) => r.startsWith("【ご注文明細】"));
  const PRICE = /単価\s*:\s*([\d,]+)\s*円\s*数量\s*:\s*(\d+)\s*個?\s*金額\s*:\s*([\d,]+)\s*円/;
  if (start >= 0) {
    for (let i = start + 1; i < rows.length; i++) {
      if (/^-{5,}/.test(rows[i]) || /税込金額/.test(rows[i])) break;
      const head = rows[i].match(/^(\d{1,3})\s+(.+)$/);
      if (!head) continue;
      // 価格は同じ行か、次の空でない行にある
      let price = head[2].match(PRICE);
      let name = head[2];
      if (price) name = head[2].slice(0, price.index).trim();
      else {
        let j = i + 1;
        while (j < rows.length && rows[j] === "") j++;
        price = rows[j]?.match(PRICE) ?? null;
        if (price) i = j;
      }
      if (!price) continue;
      lines.push({
        description: name,
        unitPrice: yenNum(price[1]),
        qty: Number(price[2]),
        lineTotal: yenNum(price[3]),
        kind: "item",
      });
    }
  }
  for (const m of text.matchAll(/(送料|代引き?手数料|決済手数料|手数料)\s*:?\s*([\d,]+)\s*円/g)) {
    const amount = yenNum(m[2]);
    if (amount > 0 && !lines.some((l) => l.kind === "fee" && l.description === m[1])) {
      lines.push({ description: m[1], qty: 1, unitPrice: amount, lineTotal: amount, kind: "fee" });
    }
  }
  const t = text.match(/税込金額[^\d\n]{0,20}([\d,]+)\s*円/);

  return check({
    parser: "dospara",
    supplierName: "ドスパラ",
    orderNo,
    orderedOn,
    paymentMethod: paymentFrom(payment),
    total: t ? yenNum(t[1]) : null,
    lines,
    issues: [],
  });
}

const PARSERS = [parseDospara];

/** 対応しているショップの一覧（画面の説明用） */
export const SUPPORTED_SHOPS = ["ドスパラ"];

/** 注文確認メールの本文を読む。対応していないショップなら null */
export function parseOrderMail(raw: string): ParsedOrder | null {
  const text = raw.normalize("NFKC").replace(/\r\n?/g, "\n");
  for (const parse of PARSERS) {
    const r = parse(text);
    if (r) return r;
  }
  return null;
}

/** ショップの商品名をそろえて、型番との対応を覚えるときの鍵にする */
export function itemKey(description: string): string {
  return description.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * 金額を数量で割り切れないとき（Amazon のメールは金額だけが書いてある）、
 * 単価が1円ちがう2行に分けて、合計がぴったり合うようにする。例: 33,657円 ÷ 5 → 6,731円×3 ＋ 6,732円×2
 */
export function splitLineTotal(lineTotal: number, qty: number): { qty: number; unitPrice: number }[] {
  if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(qty) || qty < 1 || lineTotal < 0) {
    throw new Error("金額と数量が正しくありません");
  }
  const base = Math.floor(lineTotal / qty);
  const extra = lineTotal - base * qty; // 1円多くする個数
  const parts = [{ qty: qty - extra, unitPrice: base }];
  if (extra > 0) parts.push({ qty: extra, unitPrice: base + 1 });
  return parts.filter((p) => p.qty > 0);
}
