import { type NextRequest } from "next/server";
import { canInspect, getViewer } from "@/lib/auth/session";
import { getInspectionPhotoFile } from "@/lib/inspection";
import { loadFile } from "@/lib/storage";

// 検品の写真を表示する。Google でログインした人（個体トレース）と、検品できる人（組立端末のPINも）だけ。
const SAFE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

export async function GET(_request: NextRequest, ctx: RouteContext<"/inspection/photos/[id]">) {
  const { id } = await ctx.params;
  const viewer = await getViewer();
  if (!viewer || (viewer.kind !== "user" && !canInspect(viewer))) return new Response("見つかりません", { status: 404 });
  const info = /^\d{1,15}$/.test(id) ? await getInspectionPhotoFile(Number(id)) : null;
  if (!info || !SAFE_TYPES.has(info.mimeType)) return new Response("見つかりません", { status: 404 });

  const body = await loadFile(info.storageUri);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": info.mimeType,
      "Content-Disposition": `inline; filename="${info.mgmtNo}-${id}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600", // 中身は変わらない
    },
  });
}
