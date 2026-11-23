import Link from "next/link";
import { getRestockRows } from "@/lib/fba-restock";

/** FBA の組立を始める期限を過ぎた・近い機種（ホーム。代表・管理する人だけに見せる） */
export async function FbaRestockAlert() {
  const { rows } = await getRestockRows();
  const late = rows.filter((r) => r.level === "late");
  const soon = rows.filter((r) => r.level === "soon");
  if (late.length === 0 && soon.length === 0) return null;
  const list = (rs: typeof rows) => rs.map((r) => `${r.skuCode}（目安 ${r.suggestQty}台）`).join("、");
  return (
    <Link
      href="/fba"
      className={`flex flex-col gap-1 rounded-md border-2 px-4 py-3 text-sm ${
        late.length > 0 ? "border-red-600 bg-red-50 text-red-900" : "border-amber-500 bg-amber-50 text-amber-950"
      }`}
    >
      <span className="font-bold">FBA の補充</span>
      {late.length > 0 && <span>組立を始める期限を過ぎた・今日まで：{list(late)}</span>}
      {soon.length > 0 && <span>もうすぐ期限：{list(soon)}</span>}
    </Link>
  );
}
