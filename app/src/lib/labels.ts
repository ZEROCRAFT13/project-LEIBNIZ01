// DBの値（英語のコード）を画面の日本語にする

export const unitStatusLabel: Record<string, string> = {
  planned: "組立予定",
  assembling: "組立中",
  inspecting: "検品待ち",
  ready: "出荷待ち",
  inbound_to_fba: "FBAへ輸送中",
  at_fba: "FBA在庫",
  shipped: "出荷済み",
  returned: "返品",
  in_repair: "修理中",
  scrapped: "廃棄",
};

export const slotLabel: Record<string, string> = {
  CPU: "CPU",
  GPU: "GPU",
  MB: "マザーボード",
  MEMORY: "メモリ",
  SSD: "SSD",
  PSU: "電源",
  COOLER: "CPUクーラー",
  CASE: "ケース",
  OS: "OS",
};

export const channelLabel: Record<string, string> = {
  amazon: "Amazon",
  direct: "直販",
  marketplace: "フリマ・中古",
  corporate: "法人",
  other: "その他",
};

export const linkMethodLabel: Record<string, string> = {
  shipping: "出荷時に紐づけ",
  product_registration: "製品登録で紐づけ",
  support: "問い合わせで紐づけ",
  manual: "手入力で紐づけ",
};

export const partStatusLabel: Record<string, string> = {
  in_stock: "在庫",
  installed: "取付済み",
  in_rma: "RMA中",
  scrapped: "廃棄",
  sold: "売却",
  transferred: "振替済み",
};

export const repairCoverageLabel: Record<string, string> = {
  warranty: "保証内（無償）",
  paid: "有償",
  goodwill: "無償対応",
};

export const repairStatusLabel: Record<string, string> = {
  received: "受付",
  diagnosing: "診断中",
  waiting_parts: "部品待ち",
  repairing: "修理中",
  returned: "返送済み",
  cancelled: "取消",
};

export const rmaStatusLabel: Record<string, string> = {
  preparing: "RMA準備中",
  sent: "代理店へ発送済み",
  replaced: "交換品を受領",
  refunded: "返金",
  rejected: "却下",
};

export const purchaseStatusLabel: Record<string, string> = {
  ordered: "注文済み",
  partially_received: "一部入荷",
  received: "入荷済み",
  cancelled: "取消",
};

export const paymentMethodLabel: Record<string, string> = {
  card: "カード",
  bank: "振込",
  cash: "現金",
  cod: "代引き",
  other: "その他",
};

export const partCategoryLabel: Record<string, string> = {
  cpu: "CPU",
  gpu: "GPU",
  motherboard: "マザーボード",
  memory: "メモリ",
  ssd: "SSD",
  psu: "電源",
  cooler: "CPUクーラー",
  case: "ケース",
  fan: "ファン",
  os: "OS",
  other: "その他",
};

export function label(map: Record<string, string>, code: string | null | undefined): string {
  if (code == null) return "—";
  return map[code] ?? code;
}
