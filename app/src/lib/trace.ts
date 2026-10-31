import "server-only";
import { normalizeSearch } from "@/lib/codes";
import { query } from "@/lib/db";
import { todayJst } from "@/lib/format";

// ---------------------------------------------------------------------
// 検索
// ---------------------------------------------------------------------

/** 検索欄の入力をそろえる（中身は lib/codes.ts） */
export const normalizeQuery = normalizeSearch;

export type SearchHit = {
  mgmtNo: string;
  skuCode: string;
  status: string;
  matchedBy: "mgmt_no" | "order" | "serial";
  detail: string | null;
};

/** 管理番号・注文番号・部品のシリアルで個体を探す */
export async function searchUnits(raw: string): Promise<SearchHit[]> {
  const q = normalizeQuery(raw);
  if (q.length < 3) return [];
  const rows = await query<{
    mgmt_no: string;
    sku_code: string;
    status: string;
    matched_by: SearchHit["matchedBy"];
    detail: string | null;
    sort: number;
  }>(
    `SELECT u.mgmt_no, s.code AS sku_code, u.status, 'mgmt_no' AS matched_by, NULL AS detail, 1 AS sort
       FROM core.units u JOIN core.skus s ON s.id = u.sku_id
      WHERE u.mgmt_no = $1
     UNION ALL
     SELECT u.mgmt_no, s.code, u.status, 'order', o.external_order_no, 2
       FROM core.orders o
       JOIN core.order_units ou ON ou.order_id = o.id AND ou.unlinked_at IS NULL
       JOIN core.units u ON u.id = ou.unit_id
       JOIN core.skus s ON s.id = u.sku_id
      WHERE o.external_order_no = $1
     UNION ALL
     SELECT u.mgmt_no, s.code, u.status, 'serial',
            pm.name || ' ' || p.serial_no || CASE WHEN up.removed_at IS NOT NULL THEN '（取り外し済み）' ELSE '' END,
            3
       FROM core.part_items p
       JOIN core.part_models pm ON pm.id = p.part_model_id
       JOIN core.unit_parts up ON up.part_item_id = p.id
       JOIN core.units u ON u.id = up.unit_id
       JOIN core.skus s ON s.id = u.sku_id
      WHERE upper(p.serial_no) = $1
     ORDER BY sort, mgmt_no`,
    [q],
  );
  return rows.map((r) => ({
    mgmtNo: r.mgmt_no,
    skuCode: r.sku_code,
    status: r.status,
    matchedBy: r.matched_by,
    detail: r.detail,
  }));
}

// ---------------------------------------------------------------------
// 個体1台の履歴
// ---------------------------------------------------------------------

export type TracePart = {
  slot: string;
  category: string;
  maker: string;
  name: string;
  modelNo: string;
  serialNo: string | null;
  purchasedOn: string | null;
  supplier: string | null;
  supplierOrderNo: string | null;
  costInclTax: number;
  boxKept: boolean;
  boxLocation: string | null;
  makerWarrantyMonths: number | null;
  partStatus: string;
  installedAt: Date;
  installedBy: string | null;
  overrideReason: string | null;
  removedAt: Date | null;
  removedBy: string | null;
  removeReason: string | null;
  rmaNo: string | null;
  rmaStatus: string | null;
};

export type UnitTrace = {
  mgmtNo: string;
  status: string;
  sku: { code: string; name: string };
  notes: string | null;
  /** 組立のときに残したメモ（部品として登録していないもの・作業） */
  workNotes: { note: string; by: string | null; at: Date }[];
  assembledAt: Date | null;
  assembledBy: string | null;
  inspectedAt: Date | null;
  inspectedBy: string | null;
  shippedAt: Date | null;
  shipDestination: string | null;
  order: {
    channel: string;
    externalOrderNo: string;
    isFba: boolean;
    orderedAt: Date;
    linkMethod: string;
  } | null;
  registration: { registeredAt: Date; verification: string } | null;
  warranty: {
    start: string | null;
    end: string | null;
    months: number;
    state: "active" | "expired" | "not_started";
  };
  parts: TracePart[];
  removedParts: TracePart[];
  totals: { partsCostInclTax: number; boxesKept: number };
  inspections: {
    inspector: string;
    finishedAt: Date | null;
    stressTestMinutes: number | null;
    maxCpuTempC: number | null;
    maxGpuTempC: number | null;
    noiseDb: number | null;
    result: string | null;
  }[];
  repairs: {
    symptom: string;
    coverage: string;
    status: string;
    receivedAt: Date;
    returnedAt: Date | null;
    note: string | null;
  }[];
  timeline: { label: string; at: Date | string; who: string | null }[];
};

/** 使っている部品の原価（税込）の合計と、元箱を保管している数 */
export function partTotals(parts: Pick<TracePart, "costInclTax" | "boxKept">[]) {
  return {
    partsCostInclTax: parts.reduce((sum, p) => sum + p.costInclTax, 0),
    boxesKept: parts.filter((p) => p.boxKept).length,
  };
}

/** 保証の状態。期限日の当日までは保証内 */
export function warrantyState(end: string | null, today: string = todayJst()): UnitTrace["warranty"]["state"] {
  if (end == null) return "not_started";
  return today <= end ? "active" : "expired";
}

export async function getUnitTrace(rawMgmtNo: string): Promise<UnitTrace | null> {
  const mgmtNo = normalizeQuery(rawMgmtNo);

  const [unit] = await query<{
    id: number;
    mgmt_no: string;
    status: string;
    notes: string | null;
    sku_code: string;
    sku_name: string;
    assembled_at: Date | null;
    assembled_by: string | null;
    inspected_at: Date | null;
    inspected_by: string | null;
    shipped_at: Date | null;
    ship_destination: string | null;
    warranty_start: string | null;
    warranty_end: string | null;
    warranty_months: number;
    channel: string | null;
    external_order_no: string | null;
    is_fba: boolean | null;
    ordered_at: Date | null;
    link_method: string | null;
    registered_at: Date | null;
    verification: string | null;
  }>(
    `SELECT u.id, u.mgmt_no, u.status, u.notes, s.code AS sku_code, s.name AS sku_name,
            u.assembled_at, ua.display_name AS assembled_by,
            u.inspected_at, ui.display_name AS inspected_by,
            u.shipped_at, u.ship_destination,
            w.warranty_start, w.warranty_end, w.warranty_months,
            o.channel, o.external_order_no, o.is_fba, o.ordered_at, ou.link_method,
            pr.registered_at, pr.verification
       FROM core.units u
       JOIN core.skus s ON s.id = u.sku_id
       JOIN core.v_unit_warranty w ON w.unit_id = u.id
       LEFT JOIN core.users ua ON ua.id = u.assembled_by
       LEFT JOIN core.users ui ON ui.id = u.inspected_by
       LEFT JOIN core.order_units ou ON ou.unit_id = u.id AND ou.unlinked_at IS NULL
       LEFT JOIN core.orders o ON o.id = ou.order_id
       LEFT JOIN core.product_registrations pr ON pr.unit_id = u.id
      WHERE u.mgmt_no = $1`,
    [mgmtNo],
  );
  if (!unit) return null;

  const [partRows, inspectionRows, repairRows] = await Promise.all([
    query<{
      slot: string;
      category: string;
      maker: string;
      name: string;
      model_no: string;
      serial_no: string | null;
      ordered_on: string | null;
      supplier: string | null;
      supplier_order_no: string | null;
      cost_incl_tax: number;
      box_kept: boolean;
      box_location: string | null;
      maker_warranty_months: number | null;
      part_status: string;
      installed_at: Date;
      installed_by: string | null;
      override_reason: string | null;
      removed_at: Date | null;
      removed_by: string | null;
      remove_reason: string | null;
      rma_no: string | null;
      rma_status: string | null;
    }>(
      `SELECT up.slot, pm.category, pm.maker, pm.name, pm.model_no, p.serial_no,
              pur.ordered_on, sup.name AS supplier, pur.supplier_order_no,
              (p.cost_excl_tax + p.cost_tax) AS cost_incl_tax,
              p.box_kept, p.box_location, pm.maker_warranty_months, p.status AS part_status,
              up.installed_at, uin.display_name AS installed_by, up.override_reason,
              up.removed_at, urm.display_name AS removed_by, up.remove_reason,
              rma.rma_no, rma.status AS rma_status
         FROM core.unit_parts up
         JOIN core.units u ON u.id = up.unit_id
         JOIN core.part_items p ON p.id = up.part_item_id
         JOIN core.part_models pm ON pm.id = p.part_model_id
         LEFT JOIN core.purchase_lines pl ON pl.id = p.purchase_line_id
         LEFT JOIN core.purchases pur ON pur.id = pl.purchase_id
         LEFT JOIN core.suppliers sup ON sup.id = pur.supplier_id
         LEFT JOIN core.users uin ON uin.id = up.installed_by
         LEFT JOIN core.users urm ON urm.id = up.removed_by
         LEFT JOIN core.sku_slots ss ON ss.sku_id = u.sku_id AND ss.slot = up.slot
         LEFT JOIN LATERAL (
           SELECT r.rma_no, r.status FROM core.rma_cases r
            WHERE r.part_item_id = p.id ORDER BY r.id DESC LIMIT 1
         ) rma ON true
        WHERE up.unit_id = $1
        ORDER BY ss.sort_order NULLS LAST, up.installed_at`,
      [unit.id],
    ),
    query<{
      inspector: string;
      finished_at: Date | null;
      stress_test_minutes: number | null;
      max_cpu_temp_c: number | null;
      max_gpu_temp_c: number | null;
      noise_db: number | null;
      result: string | null;
    }>(
      `SELECT us.display_name AS inspector, i.finished_at, i.stress_test_minutes,
              i.max_cpu_temp_c, i.max_gpu_temp_c, i.noise_db, i.result
         FROM core.inspections i JOIN core.users us ON us.id = i.inspector_id
        WHERE i.unit_id = $1 ORDER BY i.started_at DESC`,
      [unit.id],
    ),
    query<{
      symptom: string;
      coverage: string;
      status: string;
      received_at: Date;
      returned_at: Date | null;
      note: string | null;
    }>(
      `SELECT symptom, coverage, status, received_at, returned_at, note
         FROM core.repair_tickets WHERE unit_id = $1 ORDER BY received_at DESC`,
      [unit.id],
    ),
  ]);

  const toPart = (r: (typeof partRows)[number]): TracePart => ({
    slot: r.slot,
    category: r.category,
    maker: r.maker,
    name: r.name,
    modelNo: r.model_no,
    serialNo: r.serial_no,
    purchasedOn: r.ordered_on,
    supplier: r.supplier,
    supplierOrderNo: r.supplier_order_no,
    costInclTax: r.cost_incl_tax,
    boxKept: r.box_kept,
    boxLocation: r.box_location,
    makerWarrantyMonths: r.maker_warranty_months,
    partStatus: r.part_status,
    installedAt: r.installed_at,
    installedBy: r.installed_by,
    overrideReason: r.override_reason,
    removedAt: r.removed_at,
    removedBy: r.removed_by,
    removeReason: r.remove_reason,
    rmaNo: r.rma_no,
    rmaStatus: r.rma_status,
  });
  const parts = partRows.filter((r) => r.removed_at == null).map(toPart);
  const removedParts = partRows.filter((r) => r.removed_at != null).map(toPart);

  const repairs = repairRows.map((r) => ({
    symptom: r.symptom,
    coverage: r.coverage,
    status: r.status,
    receivedAt: r.received_at,
    returnedAt: r.returned_at,
    note: r.note,
  }));

  // 時系列（日付のあるものだけ）
  const purchaseDates = parts.map((p) => p.purchasedOn).filter((d): d is string => d != null).sort();
  const timeline: UnitTrace["timeline"] = [];
  if (purchaseDates.length > 0) {
    const first = purchaseDates[0];
    const last = purchaseDates[purchaseDates.length - 1];
    timeline.push({ label: "部品仕入れ", at: first, who: first === last ? null : `〜 ${last}` });
  }
  if (unit.assembled_at) timeline.push({ label: "組立", at: unit.assembled_at, who: unit.assembled_by });
  if (unit.inspected_at) timeline.push({ label: "検品", at: unit.inspected_at, who: unit.inspected_by });
  if (unit.shipped_at)
    timeline.push({
      label: unit.ship_destination === "fba" ? "FBAへ納品" : "出荷",
      at: unit.shipped_at,
      who: null,
    });
  if (unit.ordered_at)
    timeline.push({ label: "注文", at: unit.ordered_at, who: unit.external_order_no });
  if (unit.registered_at) timeline.push({ label: "製品登録", at: unit.registered_at, who: null });
  for (const r of [...repairs].reverse()) {
    timeline.push({ label: "修理受付", at: r.receivedAt, who: r.symptom });
    if (r.returnedAt) timeline.push({ label: "修理返送", at: r.returnedAt, who: null });
  }

  return {
    mgmtNo: unit.mgmt_no,
    status: unit.status,
    sku: { code: unit.sku_code, name: unit.sku_name },
    notes: unit.notes,
    workNotes: await query<{ note: string; by: string | null; at: Date }>(
      `SELECT n.note, us.display_name AS by, n.created_at AS at
         FROM core.unit_notes n LEFT JOIN core.users us ON us.id = n.created_by
        WHERE n.unit_id = $1 AND n.removed_at IS NULL
        ORDER BY n.created_at, n.id`,
      [unit.id],
    ),
    assembledAt: unit.assembled_at,
    assembledBy: unit.assembled_by,
    inspectedAt: unit.inspected_at,
    inspectedBy: unit.inspected_by,
    shippedAt: unit.shipped_at,
    shipDestination: unit.ship_destination,
    order:
      unit.external_order_no && unit.channel && unit.ordered_at && unit.link_method
        ? {
            channel: unit.channel,
            externalOrderNo: unit.external_order_no,
            isFba: unit.is_fba ?? false,
            orderedAt: unit.ordered_at,
            linkMethod: unit.link_method,
          }
        : null,
    registration:
      unit.registered_at && unit.verification
        ? { registeredAt: unit.registered_at, verification: unit.verification }
        : null,
    warranty: {
      start: unit.warranty_start,
      end: unit.warranty_end,
      months: unit.warranty_months,
      state: warrantyState(unit.warranty_end),
    },
    parts,
    removedParts,
    totals: partTotals(parts),
    inspections: inspectionRows.map((i) => ({
      inspector: i.inspector,
      finishedAt: i.finished_at,
      stressTestMinutes: i.stress_test_minutes,
      maxCpuTempC: i.max_cpu_temp_c,
      maxGpuTempC: i.max_gpu_temp_c,
      noiseDb: i.noise_db,
      result: i.result,
    })),
    repairs,
    timeline,
  };
}
