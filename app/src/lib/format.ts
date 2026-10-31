// 表示用の書式。日時はすべて日本時間で表示する

const dateFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** 円。例: ¥269,280 */
export function yen(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return `¥${amount.toLocaleString("ja-JP")}`;
}

/** 日付。Date（日時）でも 'YYYY-MM-DD'（日付）でも受け取り、日本時間の 'YYYY-MM-DD' にする */
export function ymd(value: Date | string | null | undefined): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.slice(0, 10);
  return dateFmt.format(value);
}

/** 日時。例: 2026-09-19 14:00 */
export function ymdHm(value: Date | null | undefined): string {
  if (value == null) return "—";
  return dateTimeFmt.format(value);
}

/** 日本時間の今日（'YYYY-MM-DD'） */
export function todayJst(now: Date = new Date()): string {
  return dateFmt.format(now);
}
