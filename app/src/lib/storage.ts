import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// 書類・検品の写真のファイルの置き場所。
//   本番・検証 … Google Cloud Storage（ZB_STORAGE_BUCKET。削除できない期間を設定したバケット）。URI は gs://バケット/aa/ハッシュ.拡張子
//   開発中     … このPCのフォルダ（ZB_STORAGE_DIR。npm run db:seed が app/.env.local に書く）。URI は local:aa/ハッシュ.拡張子
// ファイル名は中身のハッシュ（sha256）にして、一度書いたら上書きしない（同じ中身なら同じ名前なので、そのまま使う）。
// （/*turbopackIgnore: true*/ は、実行時に決まるフォルダをビルドが追いかけないための印）

const LOCAL_URI = /^local:([0-9a-f]{2})\/([0-9a-f]{64})\.(pdf|jpg|png|webp|heic)$/;
const GS_URI = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\/([0-9a-f]{2})\/([0-9a-f]{64})\.(pdf|jpg|png|webp|heic)$/;

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

/** Cloud Storage のうち、使うところだけ（テストでまねられるように） */
export type BucketLike = {
  name: string;
  file(path: string): {
    save(data: Buffer, options: { resumable: boolean; contentType: string; preconditionOpts: { ifGenerationMatch: number } }): Promise<unknown>;
    download(): Promise<[Buffer]>;
  };
};

let bucketForTest: BucketLike | null = null;
/** テストだけで使う：Cloud Storage の代わり */
export function useBucketForTest(b: BucketLike | null): void {
  bucketForTest = b;
}

async function bucket(name: string): Promise<BucketLike> {
  if (bucketForTest) return bucketForTest;
  // 開発中は読み込まない（Cloud Storage を使うときだけ）
  const { Storage } = await import("@google-cloud/storage");
  return new Storage().bucket(name) as unknown as BucketLike;
}

function storageDir(): string {
  const dir = process.env.ZB_STORAGE_DIR;
  if (!dir) {
    throw new Error(
      "書類の保存先（ZB_STORAGE_DIR または ZB_STORAGE_BUCKET）がありません。開発中はリポジトリの一番上で npm run db:seed を実行してください。",
    );
  }
  return dir;
}

/** ファイルを保存して、保存先（storage_uri）を返す。同じ中身がすでにあれば、そのまま使う */
export async function saveFile(bytes: Uint8Array, sha256: string, ext: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !(ext in MIME)) throw new Error("保存先の名前が正しくありません");
  const bucketName = process.env.ZB_STORAGE_BUCKET?.trim();
  if (bucketName) {
    const uri = `gs://${bucketName}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
    const m = uri.match(GS_URI)!;
    if (!m) throw new Error("保存先のバケット名が正しくありません");
    const b = await bucket(bucketName);
    try {
      // ifGenerationMatch: 0 … まだないときだけ書く（上書きしない）
      await b.file(`${m[2]}/${m[3]}.${m[4]}`).save(Buffer.from(bytes), {
        resumable: false,
        contentType: MIME[ext],
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 412) throw error; // 412 … もうある（同じ中身）
    }
    return uri;
  }

  const uri = `local:${sha256.slice(0, 2)}/${sha256}.${ext}`;
  const m = uri.match(LOCAL_URI)!;
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
  const gs = uri.match(GS_URI);
  if (gs) {
    const [data] = await (await bucket(gs[1])).file(`${gs[2]}/${gs[3]}.${gs[4]}`).download();
    return data;
  }
  const m = uri.match(LOCAL_URI);
  if (!m) throw new Error("このファイルの保存先には、まだつながっていません");
  return readFile(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ storageDir(), m[1], `${m[2]}.${m[3]}`));
}
