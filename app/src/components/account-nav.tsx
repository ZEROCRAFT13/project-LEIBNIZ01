import Link from "next/link";
import { logoutAction } from "@/app/login/actions";
import { canAssemble, canDocuments, canManage, canPurchase, getViewer } from "@/lib/auth/session";

const linkClass = "rounded px-3 py-2 text-stone-300 hover:bg-stone-800 hover:text-white";

// 上のメニュー。ログインしている人と役割に合わせて出し分ける（見せ分けだけ。守りは各画面の require〜）
export async function AccountNav() {
  const viewer = await getViewer();
  if (!viewer) return null;

  const links =
    viewer.kind === "worker"
      ? [{ href: "/assembly", label: "組立" }]
      : [
          { href: "/", label: "ホーム" },
          { href: "/trace", label: "個体トレース" },
          ...(canPurchase(viewer) ? [{ href: "/purchases", label: "仕入れ" }] : []),
          ...(canDocuments(viewer) ? [{ href: "/documents", label: "書類" }] : []),
          ...(canAssemble(viewer) ? [{ href: "/assembly", label: "組立" }] : []),
          ...(canManage(viewer) ? [{ href: "/settings", label: "設定" }] : []),
        ];

  return (
    <>
      <nav aria-label="メインメニュー" className="flex flex-wrap gap-1 text-sm">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={linkClass}>
            {l.label}
          </Link>
        ))}
      </nav>
      <form action={logoutAction} className="ml-auto flex items-center gap-3 text-sm">
        <span className="text-stone-300">
          {viewer.user.name}
          {viewer.device && <span className="text-stone-400">（{viewer.device.name}）</span>}
        </span>
        <button type="submit" className="rounded border border-stone-600 px-3 py-1.5 text-stone-200 hover:bg-stone-800">
          {viewer.kind === "worker" ? "作業を終える・交代" : "ログアウト"}
        </button>
      </form>
    </>
  );
}
