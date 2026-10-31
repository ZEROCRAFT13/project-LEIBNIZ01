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
