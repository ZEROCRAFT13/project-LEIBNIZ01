// SP-API（Orders API v2026-01-01）の応答のダミー。注文番号・SKU・金額はすべて作ったもの（本物のデータは使わない。ルール1）
import type { ApiOrder } from "@/lib/amazon/orders-map";

export function fakeOrder(over: {
  orderId: string;
  status?: string;
  fulfilledBy?: string;
  createdTime?: string;
  lastUpdatedTime?: string;
  shipBy?: string | null;
  items?: { sellerSku: string; qty: number; unitPrice: string; currency?: string }[];
}): ApiOrder {
  return {
    orderId: over.orderId,
    createdTime: over.createdTime ?? "2026-11-01T01:00:00Z",
    lastUpdatedTime: over.lastUpdatedTime ?? "2026-11-01T01:05:00Z",
    salesChannel: { marketplaceId: "A1VC38T7YXB528" },
    fulfillment: {
      fulfillmentStatus: over.status ?? "UNSHIPPED",
      fulfilledBy: over.fulfilledBy ?? "MERCHANT",
      ...(over.shipBy === null ? {} : { shipByWindow: { latestDateTime: over.shipBy ?? "2026-11-03T14:59:59Z" } }),
    },
    orderItems: (over.items ?? [{ sellerSku: "ZB-G5070-R7-FBM", qty: 1, unitPrice: "349800.00" }]).map((i, n) => ({
      orderItemId: `ITEM${n}`,
      quantityOrdered: i.qty,
      product: { asin: "B0ZBDUMMY2", sellerSku: i.sellerSku, price: { unitPrice: { amount: i.unitPrice, currencyCode: i.currency ?? "JPY" } } },
    })),
  };
}
