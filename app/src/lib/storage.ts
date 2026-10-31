import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// 書類のファイルの置き場所。
// 開発中はこのPCのフォルダ（ZB_STORAGE_DIR。npm run db:seed が app/.env.local に書く）に置く。
// 本番では Google Cloud Storage（削除できない期間を設定したバケット）に置く（つなぐのは本番を作るとき）。
// ファイル名は中身のハッシュ（sha256）にして、一度書いたら上書きしない。
// （/*turbopackIgnore: true*/ は、実行時に決まるフォルダをビルドが追いかけないための印）

const LOCAL_URI = /^local:([0-9a-f]{2})\/([0-9a-f]{64})\.(pdf|jpg|png|webp|heic)$/;

function storageDir(): string {
  const dir = process.env.ZB_STORAGE_DIR;
  if (!dir) {
    throw new Error(
      "書類の保存先（ZB_STORAGE_DIR）がありません。リポジトリの一番上で npm run db:seed を実行してください。",
    );
  }
  return dir;
}

/** ファイルを保存して、保存先（storage_uri）を返す。同じ中身がすでにあれば、そのまま使う */
export async function saveFile(bytes: Uint8Array, sha256: string, ext: string): Promise<string> {
  const uri = `local:${sha256.slice(0, 2)}/${sha256}.${ext}`;
  const m = uri.match(LOCAL_URI);
  if (!m) throw new Error("保存先の名前が正しくありません");
  const path = join(/*turbopackIgnore: true*/ storageDir(), m[1], `${m[2]}.${m[3]}`);
  await mkdir(/*turbopackIgnore: true*/ dirname(path), { recursive: true });
  try {
    await writeFile(/*turbopackIgnore: true*/ path, bytes, { flag: "wx" }); // 上書きしない
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return uri;
}

export async function loadFile(uri: string): Promise<Buffer> {
  const m = uri.match(LOCAL_URI);
  if (!m) throw new Error("このファイルの保存先には、まだつながっていません");
  return readFile(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ storageDir(), m[1], `${m[2]}.${m[3]}`));
}
