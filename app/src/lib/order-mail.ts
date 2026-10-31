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
  /** 型番の対応を覚える鍵（ショップの商品番号など。なければ商品名を使う） */
  key?: string;
};

export type ParsedOrder = {
  parser: string;
  /** core.suppliers の名前 */
  supplierName: string;
  orderNo: string | null;
  orderedOn: string | null;
  paymentMethod: PaymentMethod | null;
  total: number | null;
  /** メールに書いてある「うち消費税」（なければ null。確定のときに合計から計算する） */
  tax: number | null;
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
  if (order.tax !== null && order.total !== null && order.tax > order.total) {
    issues.push("うち消費税が合計より大きくなっています。");
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
  // 税込金額。印刷やコピーで行が崩れて金額が前後の行に移ることがあるので、そのときは隣の行も見る
  let t = text.match(/税込金額[^\d\n]{0,20}([\d,]+)\s*円/);
  if (!t) {
    const at = rows.findIndex((r) => r.startsWith("税込金額"));
    for (const r of at >= 0 ? [rows[at - 1], rows[at + 1]] : []) {
      const near = r?.match(/([\d,]+)\s*円(?!.*円)/);
      if (near) {
        t = near;
        break;
      }
    }
  }

  return check({
    parser: "dospara",
    supplierName: "ドスパラ",
    orderNo,
    orderedOn,
    paymentMethod: paymentFrom(payment),
    total: t ? yenNum(t[1]) : null,
    tax: null,
    lines,
    issues: [],
  });
}

// ---------------------------------------------------------------------
// Joshin web（「[Joshin web] ご注文承りました」）
//   ■ご注文内容
//   ご注文日:2026年 01月 18日
//   商品番号:0000000000000
//   商品名:○○○
//   型番:ABC-123
//   数量:8 / 単価:¥14,980 / 金額:¥119,840
//   配送料:¥0
//   合計 ¥ : 119,840
//   うち消費税 ¥ :( 10,894)
//   ■お支払い方法
//   クレジットカード
//   ご注文番号:【66447416】
// ---------------------------------------------------------------------
function parseJoshin(text: string): ParsedOrder | null {
  if (!/Joshin/i.test(text) || !/■ご注文内容/.test(text)) return null;

  const orderNo = text.match(/ご注文番号\s*:\s*【?\s*(\d{5,15})\s*】?/)?.[1] ?? text.match(/お問い合わせ番号\s*:\s*(\d{5,15})/)?.[1] ?? null;
  const d = text.match(/ご注文日\s*:\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const orderedOn = d ? `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}` : null;
  const payment = text.match(/(?:^|\n)\s*■?\s*お支払い?方法\s*\n\s*([^\n]+)/)?.[1] ?? "";

  // 商品は「商品番号」または「商品名」から次の商品までのまとまり
  const lines: ParsedLine[] = [];
  const rows = text.split("\n").map((r) => r.trim());
  let cur: { no?: string; name?: string; model?: string; qty?: number; unit?: number; amount?: number } | null = null;
  const flush = () => {
    if (cur?.name && cur.qty && cur.amount !== undefined) {
      lines.push({
        description: cur.model ? `${cur.name}（型番 ${cur.model}）` : cur.name,
        qty: cur.qty,
        unitPrice: cur.unit ?? null,
        lineTotal: cur.amount,
        kind: "item",
        key: cur.no ? `joshin:${cur.no}` : undefined,
      });
    }
    cur = null;
  };
  for (const r of rows) {
    let m: RegExpMatchArray | null;
    if ((m = r.match(/商品番号\s*:\s*(\S+)/))) {
      flush();
      cur = { no: m[1] };
    } else if ((m = r.match(/^商品名\s*:\s*(.+)$/))) {
      if (cur?.name) flush();
      cur = { ...(cur ?? {}), name: m[1].trim() };
    } else if (cur && (m = r.match(/^型番\s*:\s*(\S+)/))) cur.model = m[1];
    else if (cur && (m = r.match(/^数量\s*:\s*(\d+)/))) cur.qty = Number(m[1]);
    else if (cur && (m = r.match(/^単価\s*:\s*¥?\s*([\d,]+)/))) cur.unit = yenNum(m[1]);
    else if (cur && (m = r.match(/^金額\s*:\s*¥?\s*([\d,]+)/))) {
      cur.amount = yenNum(m[1]);
      flush();
    } else if (/商品小計/.test(r)) flush();
  }
  flush();

  for (const m of text.matchAll(/(配送料|送料|代引き?手数料)\s*:\s*¥?\s*([\d,]+)/g)) {
    const amount = yenNum(m[2]);
    if (amount > 0) lines.push({ description: m[1], qty: 1, unitPrice: amount, lineTotal: amount, kind: "fee" });
  }

  const tax = text.match(/うち消費税\s*¥?\s*:?\s*\(?\s*¥?\s*([\d,]+)/)?.[1];
  const issues: string[] = [];
  const points = text.match(/ポイント・割引クーポンでの\s*\n?\s*お支払い計\s*:\s*¥?\s*([\d,]+)/)?.[1];
  // 合計。行が崩れて読めなければ「今回お支払い予定金額」＋ポイントの分を使う
  const payNow = text.match(/予定金額\s*:\s*¥?\s*([\d,]+)/)?.[1];
  const totalText = text.match(/(?:^|\n)\s*合計\s*¥?\s*:?\s*¥?\s*([\d,]+)/)?.[1];
  const total = totalText
    ? yenNum(totalText)
    : payNow
      ? yenNum(payNow) + (points ? yenNum(points) : 0)
      : null;
  if (points && yenNum(points) > 0) {
    issues.push(`ポイント・クーポンを ${yenNum(points).toLocaleString()}円 使っています。仕入れの金額の扱いを確かめてください。`);
  }

  return check({
    parser: "joshin",
    supplierName: "Joshin",
    orderNo,
    orderedOn,
    paymentMethod: paymentFrom(payment),
    total,
    tax: tax ? yenNum(tax) : null,
    lines,
    issues,
  });
}

// ---------------------------------------------------------------------
// Amazon.co.jp（「注文済み: 「○○」N点…」）
//   注文番号 249-0000000-0000000
//   商品名（途中で「...」と切れている）
//   数量: 5
//   ¥33,657          ← 1個あたりの単価
//   合計 ¥237,879
// 商品名が途中までなので、似た商品を取りちがえないよう、確定のときに型番を確かめてもらう。
// 注文日は本文にないので、Gmail の受信日（あれば）を使う。
// ---------------------------------------------------------------------
function parseAmazon(text: string): ParsedOrder | null {
  if (!/amazon\.co\.jp/i.test(text) || !/注文番号/.test(text)) return null;

  const orderNo = text.match(/注文番号\s*[:#]?\s*(\d{3}-\d{7}-\d{7})/)?.[1] ?? null;
  const d = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const orderedOn = d ? `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}` : null;

  const rows = text.split("\n").map((r) => r.trim()).filter((r) => r !== "");
  const lines: ParsedLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const q = rows[i].match(/^数量\s*:\s*(\d+)$/);
    if (!q) continue;
    // 商品名は「数量」の前の行。表示のしかたで、名前の続きが「数量」と単価の間に入ることがある
    let name = rows[i - 1] ?? "";
    let price: RegExpMatchArray | null = null;
    for (let j = i + 1; j < Math.min(rows.length, i + 4); j++) {
      price = rows[j].match(/^¥\s*([\d,]+)$/);
      if (price) break;
      name = `${name} ${rows[j]}`;
    }
    if (!name || !price) continue;
    const qty = Number(q[1]);
    const unit = yenNum(price[1]);
    lines.push({ description: name.replace(/\s+/g, " "), qty, unitPrice: unit, lineTotal: unit * qty, kind: "item" });
  }
  const total = text.match(/(?:^|\n)\s*(?:ご請求額|注文の合計|合計)\s*:?\s*¥\s*([\d,]+)/)?.[1];

  const issues: string[] = [];
  if (lines.some((l) => /(\.\.\.|…)$/.test(l.description))) {
    issues.push("Amazon のメールは商品名が途中までしか書かれていません。容量ちがいなど似た商品を取りちがえないよう、型番をよく確かめてください。");
  }
  if (orderedOn) issues.push("注文日はメールの日付から入れました。ちがっていたら直してください。");

  return check({
    parser: "amazon",
    supplierName: "Amazon",
    orderNo,
    orderedOn,
    paymentMethod: null,
    total: total ? yenNum(total) : null,
    tax: null,
    lines,
    issues,
  });
}

const PARSERS = [parseDospara, parseJoshin, parseAmazon];

/** 対応しているショップの一覧（画面の説明用） */
export const SUPPORTED_SHOPS = ["ドスパラ", "Joshin web", "Amazon.co.jp"];

/** 注文確認メールの本文を読む。対応していないショップなら null */
export function parseOrderMail(raw: string): ParsedOrder | null {
  // 右から左の向きを指定する見えない文字（Amazon のメールに入っている）も取る
  const text = raw
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
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
