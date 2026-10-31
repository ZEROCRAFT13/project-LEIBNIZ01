// 番号やバーコードの文字をそろえる（画面でもサーバーでも使える）

/**
 * 全角→半角、小文字→大文字、いろいろなハイフン→「-」、空白を取る。
 * 日本語入力がオンのままバーコードを読んで全角になった場合もこれで戻る。
 */
export function normalizeCode(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[‐‑‒–—―ー−]/g, "-")
    .replace(/\s+/g, "");
}

const MGMT_NO = /^ZB-\d{4}-\d{4}$/;

/** 管理番号（ZB-年月-連番）かどうか */
export function isMgmtNo(code: string): boolean {
  return MGMT_NO.test(code);
}

/**
 * 検索欄の入力をそろえる。「2609-0118」や「ZB26090118」は「ZB-2609-0118」にする。
 * （部品のシリアルが数字だけのこともあるので、組立の読み取りでは使わない）
 */
export function normalizeSearch(raw: string): string {
  const q = normalizeCode(raw);
  let m = q.match(/^(?:ZB-?)?(\d{4})-?(\d{4})$/);
  if (m && (q.startsWith("ZB") || q.includes("-"))) return `ZB-${m[1]}-${m[2]}`;
  m = q.match(/^ZB(\d{4})(\d{4})$/);
  if (m) return `ZB-${m[1]}-${m[2]}`;
  return q;
}
