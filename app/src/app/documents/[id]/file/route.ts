import { type NextRequest } from "next/server";
import { requireDocuments } from "@/lib/auth/session";
import { getDocumentFileInfo } from "@/lib/documents";
import { loadFile } from "@/lib/storage";

// 書類のファイルを表示・ダウンロードする。書類を扱える人だけ。
// 取り込むときに中身を確かめた種類（PDF・画像）だけを、その種類として返す。
const SAFE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);

export async function GET(request: NextRequest, ctx: RouteContext<"/documents/[id]/file">) {
  const { id } = await ctx.params;
  await requireDocuments(`/documents/${encodeURIComponent(id)}`);
  const info = /^\d{1,15}$/.test(id) ? await getDocumentFileInfo(Number(id)) : null;
  if (!info || !SAFE_TYPES.has(info.mimeType)) return new Response("見つかりません", { status: 404 });

  const body = await loadFile(info.storageUri);
  const download = request.nextUrl.searchParams.get("download") === "1";
  const name = encodeURIComponent(info.originalName ?? `document-${id}`);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": info.mimeType,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600", // 中身は変わらない
    },
  });
}
