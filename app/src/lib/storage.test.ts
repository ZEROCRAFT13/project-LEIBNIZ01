// ファイルの置き場所（開発中はフォルダ、本番は Cloud Storage。Cloud Storage はまねる）
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFile, saveFile, useBucketForTest, type BucketLike } from "./storage";

let tmp: string;
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const sha = createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "zb-storage-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.ZB_STORAGE_BUCKET;
  useBucketForTest(null);
});

/** Cloud Storage のまね。もうある名前に ifGenerationMatch: 0 で書くと 412 */
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const saves: { path: string; options: unknown }[] = [];
  const b: BucketLike = {
    name: "zerobit-prod-files",
    file(path) {
      return {
        async save(data, options) {
          saves.push({ path, options });
          if (options.preconditionOpts.ifGenerationMatch === 0 && objects.has(path)) throw Object.assign(new Error("exists"), { code: 412 });
          objects.set(path, data);
        },
        async download() {
          const d = objects.get(path);
          if (!d) throw Object.assign(new Error("not found"), { code: 404 });
          return [d];
        },
      };
    },
  };
  return { b, objects, saves };
}

describe("開発中（フォルダ）", () => {
  it("中身のハッシュの名前で保存し、読み戻せる", async () => {
    process.env.ZB_STORAGE_DIR = tmp;
    const uri = await saveFile(bytes, sha, "jpg");
    expect(uri).toBe(`local:${sha.slice(0, 2)}/${sha}.jpg`);
    expect(new Uint8Array(await loadFile(uri))).toEqual(bytes);
    // 同じ中身をもう一度保存しても、そのまま使う
    expect(await saveFile(bytes, sha, "jpg")).toBe(uri);
  });
});

describe("本番（Cloud Storage）", () => {
  it("上書きしない条件つきで保存し、gs:// の URI を返す。読み戻せる", async () => {
    const { b, saves } = fakeBucket();
    useBucketForTest(b);
    process.env.ZB_STORAGE_BUCKET = "zerobit-prod-files";
    const uri = await saveFile(bytes, sha, "jpg");
    expect(uri).toBe(`gs://zerobit-prod-files/${sha.slice(0, 2)}/${sha}.jpg`);
    expect(saves[0]).toEqual({
      path: `${sha.slice(0, 2)}/${sha}.jpg`,
      options: { resumable: false, contentType: "image/jpeg", preconditionOpts: { ifGenerationMatch: 0 } },
    });
    expect(new Uint8Array(await loadFile(uri))).toEqual(bytes);
  });

  it("同じ中身がもうあれば（412）、そのまま使う", async () => {
    const { b } = fakeBucket();
    useBucketForTest(b);
    process.env.ZB_STORAGE_BUCKET = "zerobit-prod-files";
    const first = await saveFile(bytes, sha, "pdf");
    expect(await saveFile(bytes, sha, "pdf")).toBe(first);
  });

  it("おかしな名前は保存しない", async () => {
    process.env.ZB_STORAGE_BUCKET = "zerobit-prod-files";
    useBucketForTest(fakeBucket().b);
    await expect(saveFile(bytes, "x", "jpg")).rejects.toThrow();
    await expect(saveFile(bytes, sha, "exe")).rejects.toThrow();
    process.env.ZB_STORAGE_BUCKET = "Bad_Bucket!";
    await expect(saveFile(bytes, sha, "jpg")).rejects.toThrow("バケット名");
  });

  it("知らない形の URI は読まない", async () => {
    await expect(loadFile("s3://x/y.jpg")).rejects.toThrow();
    await expect(loadFile("gs://zerobit-prod-files/../etc/passwd")).rejects.toThrow();
  });
});
