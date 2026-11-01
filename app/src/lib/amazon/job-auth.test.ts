// 定期実行の合言葉
import { describe, expect, it } from "vitest";
import { jobSecretOk } from "@/lib/amazon/job-auth";

const secret = "s".repeat(40);

describe("定期実行の合言葉", () => {
  it("Bearer で同じ合言葉のときだけ通す", () => {
    expect(jobSecretOk(`Bearer ${secret}`, secret)).toBe(true);
    expect(jobSecretOk(`Bearer ${secret}x`, secret)).toBe(false);
    expect(jobSecretOk(secret, secret)).toBe(false);
    expect(jobSecretOk(null, secret)).toBe(false);
  });

  it("合言葉が設定されていない・短すぎるときは、誰も通さない", () => {
    expect(jobSecretOk("Bearer ", undefined)).toBe(false);
    expect(jobSecretOk("Bearer short", "short")).toBe(false);
  });
});
