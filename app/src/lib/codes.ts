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
  const fromLabel = mgmtNoFromLabel(raw);
  if (fromLabel) return fromLabel;
  const q = normalizeCode(raw);
  let m = q.match(/^(?:ZB-?)?(\d{4})-?(\d{4})$/);
  if (m && (q.startsWith("ZB") || q.includes("-"))) return `ZB-${m[1]}-${m[2]}`;
  m = q.match(/^ZB(\d{4})(\d{4})$/);
  if (m) return `ZB-${m[1]}-${m[2]}`;
  return q;
}

/**
 * 管理番号シールの QR を読んだとき（中身は製品登録の URL。例 https://…/r/ZB-2610-0045）、管理番号を取り出す。
 * URL でなければ null（部品のシリアルに ZB-… が含まれていても取り違えないように）。
 */
export function mgmtNoFromLabel(raw: string): string | null {
  const t = raw.normalize("NFKC").trim();
  if (!/^https?:\/\//i.test(t)) return null;
  const m = t.toUpperCase().match(/\/R\/(ZB-\d{4}-\d{4})(?:[/?#]|$)/);
  return m ? m[1] : null;
}
