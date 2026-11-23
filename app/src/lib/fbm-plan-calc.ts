// 自社出荷の作り方と Amazon の出品数（計算だけ。ルール5）
//   作り置き（stock）      … 出品数 ＝ 出荷待ちの台数。出荷待ち＋組立中が目標の台数に足りなければ、組立の ToDo
//   注文を受けてから組む（to_order） … 出品数 ＝ 出荷待ち ＋ 部品の在庫で組める台数（上限 maxToOrder 台）
//   両方（both）の機種     … FBA に販売できる在庫があるあいだは 0（FBA で売る。切れたら自社出荷でも売る）

export type FbmPolicy = "stock" | "to_order";
export const fbmPolicyLabel: Record<FbmPolicy, string> = { stock: "作り置き", to_order: "注文を受けてから組む" };

export type ListingQtyInput = {
  fulfillment: "fbm" | "both";
  policy: FbmPolicy;
  /** 出荷待ちで、注文にも FBA の納品にも入っていない台数 */
  ready: number;
  /** 部品の在庫で組める台数 */
  buildable: number;
  maxToOrder: number;
  /** FBA で販売できる数（最後に取り込んだもの。まだなければ null） */
  fbaFulfillable: number | null;
};

export function fbmListingQty(i: ListingQtyInput): { qty: number; why: string } {
  if (i.fulfillment === "both" && (i.fbaFulfillable ?? 0) > 0) {
    return { qty: 0, why: `FBA に在庫があるあいだは自社出荷では売らない（FBA ${i.fbaFulfillable}台）` };
  }
  const ready = Math.max(0, i.ready);
  if (i.policy === "stock") return { qty: ready, why: `出荷待ち ${ready}台` };
  const extra = Math.min(Math.max(0, i.maxToOrder), Math.max(0, i.buildable));
  return { qty: ready + extra, why: `出荷待ち ${ready}台 ＋ 部品で組める ${extra}台（上限 ${i.maxToOrder}台）` };
}

export type SlotStock = { required: boolean; anyPart: boolean; qty: number; inStock: number };

/** 構成表の「必ず付ける」枠ごとの部品の在庫から、何台組めるか（自由枠・付けなくてもよい枠は数えない。必ず付ける枠がなければ 0） */
export function buildableFromParts(slots: SlotStock[]): number {
  const req = slots.filter((s) => s.required && !s.anyPart && s.qty > 0);
  if (req.length === 0) return 0;
  return Math.max(0, Math.min(...req.map((s) => Math.floor(Math.max(0, s.inStock) / s.qty))));
}

/** 作り置きで、あと何台組めばよいか（出荷待ち＋組立中・検品中が目標に足りない数） */
export function stockShortage(policy: FbmPolicy, target: number, readyPlusPipeline: number): number {
  return policy === "stock" ? Math.max(0, target - Math.max(0, readyPlusPipeline)) : 0;
}
