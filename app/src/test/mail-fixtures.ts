// テスト用の注文確認メール（ショップのメールの形をまねた作り物。氏名・住所・番号はすべて架空: ルール1）

export function dosparaMail(opts: {
  orderNo?: string;
  date?: string;
  items?: { name: string; unit: number; qty: number }[];
  shipping?: number;
  total?: number;
  payment?: string;
}): string {
  const items = opts.items ?? [
    { name: "メーカーC B850 ATX (B850 AM5 ATX)", unit: 24980, qty: 2 },
    { name: "メーカーS NV4-1TB (NVMe Gen4 1TB)", unit: 12980, qty: 3 },
  ];
  const sum = items.reduce((s, i) => s + i.unit * i.qty, 0) + (opts.shipping ?? 0);
  const total = opts.total ?? sum;
  return [
    "ドスパラWEBサイトより -ご注文確定のお知らせ-",
    "noreply-pay@dospara.example",
    "",
    "見本 太郎 様",
    "この度は、ドスパラWEBをご利用頂き、ありがとうございます。",
    "クレジット会社より承認がおりましたので、ご連絡差し上げます。",
    "こちらのメールをもちまして「ご注文確定」となります。",
    "",
    "----------------------------------------------------------------------",
    "■ 注文書",
    "----------------------------------------------------------------------",
    `【ご注文番号】 ${opts.orderNo ?? "EC0000000001"}`,
    `【受注日】 ${opts.date ?? "2026/10/30"}`,
    `【お支払方法】 ${opts.payment ?? "W)ﾐﾎﾝｶｰﾄﾞ(105) 1回"}`,
    "【ご注文明細】",
    ...items.flatMap((it, i) => [
      `${i + 1} ${it.name}`,
      `単価：${it.unit.toLocaleString()}円 数量：${it.qty}個 金額：${(it.unit * it.qty).toLocaleString()}円`,
    ]),
    "-------------------------------------------",
    ...(opts.shipping ? [`送料： ${opts.shipping.toLocaleString()}円`] : []),
    `税込金額：       ${total.toLocaleString()}円`,
    "",
    "【お届け先】 大阪府見本市1-2-3 見本 太郎",
  ].join("\r\n");
}

/** Joshin web の「ご注文承りました」（Gmail で表示したときの文字の形） */
export function joshinMail(opts: {
  orderNo?: string;
  items?: { no: string; name: string; model: string; unit: number; qty: number }[];
  shipping?: number;
  points?: number;
}): string {
  const items = opts.items ?? [
    { no: "4500000000001", name: "メーカーC B850 ATX マザーボード【国内正規品】", model: "B850-ATX", unit: 24980, qty: 2 },
  ];
  const subtotal = items.reduce((s, i) => s + i.unit * i.qty, 0);
  const total = subtotal + (opts.shipping ?? 0);
  const tax = total - Math.round((total * 10) / 11);
  const no = opts.orderNo ?? "66000001";
  return [
    `[Joshin web] ご注文承りました ( お問い合わせ番号 :${no})`,
    "Joshin web 事務局. <auto@joshin.example>",
    "（このメールは配信専用のアドレスで自動配信にてお送りさせていただいております。）",
    "見本太郎様",
    "この度は『Joshin webショップ』をご利用いただきまして、まことにありがとうございます。",
    "■ご注文内容",
    "ご注文日:2026年 01月 18日",
    "--------------------",
    ...items.flatMap((it) => [
      `   商品番号:${it.no}`,
      `      商品名:${it.name}`,
      `         型番:${it.model}`,
      "         在庫:○在庫あり",
      "   出荷目安:最短 1月19日( 月 ) 出荷",
      `         数量:${it.qty}`,
      `         単価:￥${it.unit.toLocaleString()}`,
      `         金額:￥${(it.unit * it.qty).toLocaleString()}`,
      "--------------------",
    ]),
    `   商品小計:￥${subtotal.toLocaleString()}`,
    `      配送料:￥${(opts.shipping ?? 0).toLocaleString()}`,
    "--------------------",
    "====================",
    `   合計 ￥  : ${total.toLocaleString()}`,
    `うち消費税 ￥  :( ${tax.toLocaleString()})`,
    "====================",
    "ポイント・割引クーポンでの",
    `お支払い計:${opts.points ?? 0}`,
    "====================",
    "■お支払い方法",
    "クレジットカード",
    "■ご注文に関するお問い合わせ",
    `ご注文番号:【${no}】`,
    "上新電機株式会社 Joshin web 事務局",
  ].join("\n");
}

/** Amazon.co.jp の「注文済み」（Gmail で表示したときの文字の形。商品名は途中で切れている） */
export function amazonMail(opts: { orderNo?: string; items?: { name: string; unit: number; qty: number }[]; date?: boolean }): string {
  const items = opts.items ?? [
    { name: "メーカーM DDR5-5600 32GB デスクトップPC用 メモ...", unit: 21980, qty: 2 },
    { name: "メーカーS NVMe SSD 1TB Gen4 Internal SSD -...", unit: 12980, qty: 3 },
  ];
  const total = items.reduce((s, i) => s + i.unit * i.qty, 0);
  return [
    `注文済み: 「${items[0].name.slice(0, 20)}...」${items[0].qty}点とさらに${items.slice(1).reduce((s, i) => s + i.qty, 0)}点の商品`,
    `Amazon.co.jp <auto-confirm@amazon.example>${opts.date === false ? "" : "  2026年2月23日 8:15"}`,
    "注文履歴 アカウントサービス 再購入",
    "見本 太郎様、ご注文ありがとうございます。",
    "注文済み 発送済み 配達中 配達済み",
    "明日到着予定",
    "見本太郎 - 大阪府",
    `注文番号 \u202b\u202b\u202c${opts.orderNo ?? "249-0000001-0000001"}`,
    "注文内容の表示と変更",
    ...items.flatMap((it) => [it.name, `数量: ${it.qty}`, `￥${it.unit.toLocaleString()}`]),
    `合計                                ￥${total.toLocaleString()}`,
    "セール商品のお買い物を続ける",
    "-25%   ￥11,199.          -34%   ￥5,290.",
    "©2026 Amazon.com. All rights reserved.",
    "送信者：アマゾンジャパン合同会社",
  ].join("\n");
}
