// ToDo（ダミーデータの DB に対して）。自社出荷の注文から自動で作る・進む・完了する
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUnit } from "@/lib/assembly";
import { getPool, query } from "@/lib/db";
import { cancelFbmOrder, createFbmOrder, linkUnit, markFbmShipped, markShipNotified, setOrderTracking, updateFbmOrderInfo } from "@/lib/fbm";
import { addManualTask, countOpenTasks, finishManualTask, listOpenTasks, listRecentlyFinished } from "@/lib/tasks";

let owner: number;
let r7: number;
const ALL = ["ceo", "factory_manager", "admin_lead", "support", "marketing_lead", "project_lead"];

async function readyUnit(): Promise<string> {
  const sato = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'sato@zerobit.example'"))[0].id;
  const m = await startUnit(sato, r7);
  await query(`UPDATE core.units SET status = 'ready', assembled_at = now(), inspected_at = now() WHERE mgmt_no = $1`, [m]);
  return m;
}

const jstDate = (offsetDays: number) => {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  owner = (await query<{ id: number }>("SELECT id FROM core.users WHERE email = 'owner@zerobit.example'"))[0].id;
  r7 = (await query<{ id: number }>("SELECT id FROM core.skus WHERE code = 'ZB-G5070-R7'"))[0].id;
});

afterAll(async () => {
  await getPool().end();
});

const order = (orderNo: string, shipBy: string | null) =>
  createFbmOrder(owner, { orderNo, orderedAt: new Date(), shipBy, skuId: r7, qty: 1, totalAmount: 349800, note: null }) as Promise<{
    ok: boolean;
    id: number;
    message: string;
  }>;

const taskOf = async (orderId: number) =>
  (await listOpenTasks(ALL)).find((t) => t.sourceRef === `order:${orderId}`) ??
  (await listRecentlyFinished(ALL)).find((t) => t.sourceRef === `order:${orderId}`);

describe("自社出荷の注文から ToDo を作る", () => {
  let id: number;
  let unit: string;

  it("注文を登録すると「出荷する」タスクができる。担当は工場長、期限は出荷期限の日の終わり", async () => {
    const r = await order("503-0000002-0000001", "2099-01-02");
    expect(r.message).toContain("ToDo");
    id = r.id;
    const t = await taskOf(id);
    expect(t).toMatchObject({
      title: "自社出荷：503-0000002-0000001（ZB-G5070-R7 × 1）を出荷する",
      roleCode: "factory_manager",
      assignee: "代表",
      status: "todo",
      overdue: false,
      sourceKind: "system",
    });
    expect(t?.dueAt?.toISOString()).toBe("2099-01-02T15:00:00.000Z");
    expect(t?.order).toMatchObject({ id, qty: 1, linked: 0, shipped: false, notified: false });
  });

  it("個体を結びつけると進行中になり、進み具合が出る", async () => {
    unit = await readyUnit();
    await linkUnit(owner, id, unit);
    expect(await taskOf(id)).toMatchObject({ status: "in_progress", order: { linked: 1 } });
  });

  it("発送しただけでは終わらない。出荷通知を記録すると完了する", async () => {
    await setOrderTracking(owner, id, unit, "2222-3333-4444");
    await updateFbmOrderInfo(owner, id, { carrier: "sagawa", note: null });
    await markFbmShipped(owner, id);
    expect(await taskOf(id)).toMatchObject({ status: "in_progress", order: { shipped: true, notified: false } });
    expect(await markShipNotified(owner, id)).toMatchObject({ ok: true });
    const t = await taskOf(id);
    expect(t).toMatchObject({ status: "done", completedBy: "代表", delayReason: null });
    const ev = await query<{ event: string }>(`SELECT event FROM core.task_events WHERE task_id = $1 ORDER BY id`, [t!.id]);
    expect(ev.map((e) => e.event)).toEqual(["created", "started", "completed"]);
  });

  it("出荷期限を過ぎたら期限超過になり、出荷通知には遅れた理由が要る", async () => {
    const r = await order("503-0000002-0000002", jstDate(-1));
    const t = await taskOf(r.id);
    expect(t).toMatchObject({ overdue: true });
    const before = await countOpenTasks(ALL);
    expect(before.overdue).toBeGreaterThanOrEqual(1);

    const u = await readyUnit();
    await linkUnit(owner, r.id, u);
    await setOrderTracking(owner, r.id, u, "2222-3333-5555");
    await updateFbmOrderInfo(owner, r.id, { carrier: "yamato", note: null });
    await markFbmShipped(owner, r.id);
    expect(await markShipNotified(owner, r.id)).toMatchObject({ ok: false, message: "期限を過ぎているので、遅れた理由を書いてください。" });
    // 断ったときは、出荷通知の記録も残らない（一緒に取り消される）
    const [o] = await query<{ n: Date | null }>(`SELECT ship_notified_at AS n FROM core.orders WHERE id = $1`, [r.id]);
    expect(o.n).toBeNull();
    expect(await markShipNotified(owner, r.id, "部品の入荷待ち")).toMatchObject({ ok: true });
    expect(await taskOf(r.id)).toMatchObject({ status: "done", delayReason: "部品の入荷待ち" });
  });

  it("出荷期限が今日なら「今日まで」", async () => {
    const r = await order("503-0000002-0000003", jstDate(0));
    expect(await taskOf(r.id)).toMatchObject({ overdue: false, dueToday: true });
    await cancelFbmOrder(owner, r.id, "テスト");
  });

  it("注文を取り消すとタスクも取り消しになる", async () => {
    const r = await order("503-0000002-0000004", null);
    expect(await taskOf(r.id)).toMatchObject({ status: "todo", dueAt: null });
    await cancelFbmOrder(owner, r.id, "お客様のキャンセル");
    expect(await taskOf(r.id)).toMatchObject({ status: "cancelled", cancelReason: "注文の取り消し：お客様のキャンセル" });
  });

  it("出せる個体の数も出る（足りなければ組立を急ぐ）", async () => {
    const r = await order("503-0000002-0000005", null);
    const t = await taskOf(r.id);
    const [n] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.units u WHERE u.sku_id = $1 AND u.status = 'ready'
         AND NOT EXISTS (SELECT 1 FROM core.order_units x WHERE x.unit_id = u.id AND x.unlinked_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM core.fba_shipment_units su JOIN core.fba_shipments s ON s.id = su.shipment_id
                          WHERE su.unit_id = u.id AND s.status <> 'cancelled')`,
      [r7],
    );
    expect(t?.order?.available).toBe(n.n);
  });
});

describe("手で足すタスク", () => {
  it("足して、完了にする", async () => {
    expect(await addManualTask(owner, { title: "梱包材を発注する", roleCode: "factory_manager", dueAt: null, description: null })).toMatchObject({
      ok: true,
    });
    const t = (await listOpenTasks(ALL)).find((x) => x.title === "梱包材を発注する")!;
    expect(t).toMatchObject({ sourceKind: "manual", status: "todo" });
    expect(await finishManualTask(owner, t.id, { done: true, delayReason: null })).toMatchObject({ ok: true });
    expect(await finishManualTask(owner, t.id, { done: true, delayReason: null })).toMatchObject({ ok: false });
  });

  it("期限を過ぎたものは理由が要る。取り消しにも理由が要る", async () => {
    await addManualTask(owner, { title: "電話する", roleCode: "ceo", dueAt: new Date(Date.now() - 3600_000), description: null });
    const t = (await listOpenTasks(ALL)).find((x) => x.title === "電話する")!;
    expect(t.overdue).toBe(true);
    expect(await finishManualTask(owner, t.id, { done: true, delayReason: null })).toMatchObject({ ok: false });
    expect(await finishManualTask(owner, t.id, { done: false, cancelReason: " " })).toMatchObject({ ok: false });
    expect(await finishManualTask(owner, t.id, { done: true, delayReason: "相手が不在" })).toMatchObject({ ok: true });
  });

  it("自動で作ったタスクは、手では完了にできない", async () => {
    const r = await order("503-0000002-0000006", null);
    const t = (await taskOf(r.id))!;
    expect(await finishManualTask(owner, t.id, { done: true, delayReason: null })).toMatchObject({
      ok: false,
      message: "このタスクは、もとの作業が終わると自動で完了します。",
    });
  });

  it("自分の役割のタスクだけが出る", async () => {
    const onlySupport = await listOpenTasks(["support"]);
    expect(onlySupport.every((t) => t.roleCode === "support")).toBe(true);
  });
});
