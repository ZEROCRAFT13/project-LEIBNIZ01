// ToDo の入力の確かめ（DBを使わない）
import { describe, expect, it } from "vitest";
import { dueGroup, endOfJstDay, orderNextStep, parseManualTask } from "@/lib/task-calc";

describe("期限", () => {
  it("日付はその日の終わり（日本時間）にする", () => {
    expect(endOfJstDay("2026-11-03")?.toISOString()).toBe("2026-11-03T15:00:00.000Z");
    expect(endOfJstDay("11/3")).toBeNull();
  });

  it("画面での分け方", () => {
    expect(dueGroup({ overdue: true, dueToday: true, dueAt: new Date() })).toBe("overdue");
    expect(dueGroup({ overdue: false, dueToday: true, dueAt: new Date() })).toBe("today");
    expect(dueGroup({ overdue: false, dueToday: false, dueAt: new Date() })).toBe("later");
    expect(dueGroup({ overdue: false, dueToday: false, dueAt: null })).toBe("none");
  });
});

describe("手で足すタスク", () => {
  it("やること・役割・期限を受け取る", () => {
    expect(parseManualTask({ title: " 梱包材を  発注 ", roleCode: "factory_manager", due: "2026-11-05" }, ["ceo", "factory_manager"])).toEqual({
      ok: true,
      value: { title: "梱包材を 発注", roleCode: "factory_manager", dueAt: new Date("2026-11-05T15:00:00Z"), description: null },
    });
  });

  it("持っていない役割・空・おかしな期限は止める", () => {
    const r = parseManualTask({ title: "", roleCode: "admin_lead", due: "あした" }, ["ceo"]);
    expect(r.ok ? [] : r.errors).toEqual([
      "やることを書いてください（200文字まで）。",
      "担当の役割を選んでください。",
      "期限は日付で入れてください。",
    ]);
  });
});

describe("自社出荷のタスクの次にやること", () => {
  const base = { qty: 2, linked: 0, shipped: false, notified: false, available: 5 };
  it("結びつけ → 発送 → 出荷通知", () => {
    expect(orderNextStep(base)).toEqual({ text: "個体を結びつける（あと 2台）", warn: false });
    expect(orderNextStep({ ...base, linked: 2 })).toEqual({ text: "送り状番号を入れて発送する", warn: false });
    expect(orderNextStep({ ...base, linked: 2, shipped: true })).toEqual({ text: "セラーセントラルで出荷通知をする", warn: false });
  });

  it("出せる個体が足りなければ、組立・検品を急ぐように出す", () => {
    expect(orderNextStep({ ...base, linked: 0, available: 1 })).toEqual({
      text: "個体を結びつける（出せる個体が 1台 足りません。組立・検品を急ぐ）",
      warn: true,
    });
  });
});
