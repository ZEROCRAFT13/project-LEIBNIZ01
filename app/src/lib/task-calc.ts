// ToDo の入力の確かめ（DBを使わない）

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** 期限の日（YYYY-MM-DD、日本の日付）→ その日の終わり（翌日 0:00 日本時間） */
export function endOfJstDay(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 86_400_000);
}

export function parseManualTask(
  raw: Record<string, unknown>,
  allowedRoles: string[],
): Parsed<{ title: string; roleCode: string; dueAt: Date | null; description: string | null }> {
  const errors: string[] = [];
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const title = s("title").normalize("NFC").replace(/\s+/g, " ").trim();
  if (title.length < 1 || title.length > 200) errors.push("やることを書いてください（200文字まで）。");
  const roleCode = s("roleCode");
  if (!allowedRoles.includes(roleCode)) errors.push("担当の役割を選んでください。");
  const due = s("due").normalize("NFKC").trim();
  let dueAt: Date | null = null;
  if (due !== "") {
    dueAt = endOfJstDay(due);
    if (!dueAt) errors.push("期限は日付で入れてください。");
  }
  const description = s("description").normalize("NFC").trim();
  if (description.length > 1000) errors.push("メモは1000文字までにしてください。");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { title, roleCode, dueAt, description: description || null } };
}

export type DueGroup = "overdue" | "today" | "later" | "none";

/** ToDo の画面での分け方 */
export function dueGroup(t: { overdue: boolean; dueToday: boolean; dueAt: Date | null }): DueGroup {
  if (t.overdue) return "overdue";
  if (t.dueToday) return "today";
  if (t.dueAt) return "later";
  return "none";
}

export const dueGroupLabel: Record<DueGroup, string> = {
  overdue: "期限を過ぎています",
  today: "今日まで",
  later: "これから",
  none: "期限なし",
};

/** 自社出荷のタスクの「次にやること」 */
export function orderNextStep(o: { qty: number; linked: number; shipped: boolean; notified: boolean; available: number }): {
  text: string;
  warn: boolean;
} {
  if (!o.shipped && o.linked < o.qty) {
    const need = o.qty - o.linked;
    if (o.available < need) {
      return { text: `個体を結びつける（出せる個体が ${need - o.available}台 足りません。組立・検品を急ぐ）`, warn: true };
    }
    return { text: `個体を結びつける（あと ${need}台）`, warn: false };
  }
  if (!o.shipped) return { text: "送り状番号を入れて発送する", warn: false };
  if (!o.notified) return { text: "セラーセントラルで出荷通知をする", warn: false };
  return { text: "済み", warn: false };
}
