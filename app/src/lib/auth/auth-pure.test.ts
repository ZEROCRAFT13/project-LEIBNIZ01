// ログインの部品のうち、DBを使わないもののテスト（PIN・登録コード・Google の確認・戻り先）
import { describe, expect, it } from "vitest";
import {
  formatEnrollCode,
  hashPin,
  newEnrollCode,
  newToken,
  normalizeEnrollCode,
  normalizePin,
  pinProblem,
  tokenHash,
  verifyPin,
} from "./crypto";
import { authorizeUrl, checkIdToken, decodeJwtPayload, googleConfig, newOAuthStart, safeNext } from "./google";

describe("PIN", () => {
  it.each([
    ["1357", null],
    ["2468", null],
    ["0907", null],
    ["123", "PINは4桁の数字にしてください。"],
    ["12a4", "PINは4桁の数字にしてください。"],
    ["1111", "同じ数字だけのPIN（1111 など）は使えません。"],
    ["1234", "連続した数字のPIN（1234・9876 など）は使えません。"],
    ["9876", "連続した数字のPIN（1234・9876 など）は使えません。"],
  ])("%s → %s", (pin, problem) => {
    expect(pinProblem(pin)).toBe(problem);
  });

  it("全角の数字でも入れられる", () => {
    expect(normalizePin(" １３５７ ")).toBe("1357");
  });

  it("ハッシュにして保存し、同じPINだけが合う", async () => {
    const stored = await hashPin("1357");
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(stored).not.toContain("1357");
    expect(await verifyPin("1357", stored)).toBe(true);
    expect(await verifyPin("1358", stored)).toBe(false);
    // 同じPINでも毎回ちがうハッシュになる（塩）
    expect(await hashPin("1357")).not.toBe(stored);
  });

  it("形の壊れたハッシュは合わない", async () => {
    expect(await verifyPin("1357", "plain")).toBe(false);
    expect(await verifyPin("1357", "md5$x$y")).toBe(false);
  });
});

describe("鍵と登録コード", () => {
  it("鍵は毎回ちがい、DBにはハッシュ（32バイト）だけを入れる", () => {
    const a = newToken();
    expect(a).not.toBe(newToken());
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(tokenHash(a)).toHaveLength(32);
    expect(tokenHash(a).equals(tokenHash(a))).toBe(true);
  });

  it("登録コードは8桁。ハイフンや全角でも入れられる", () => {
    const code = newEnrollCode();
    expect(code).toMatch(/^\d{8}$/);
    expect(formatEnrollCode("12345678")).toBe("1234-5678");
    expect(normalizeEnrollCode("1234-5678")).toBe("12345678");
    expect(normalizeEnrollCode("１２３４ ５６７８")).toBe("12345678");
    expect(normalizeEnrollCode("1234-567")).toBeNull();
  });
});

describe("Google の ID トークンを確かめる", () => {
  const expect_ = { clientId: "cid.apps.googleusercontent.com", nonce: "n1", domain: "zerobit.example", nowSec: 1_800_000_000 };
  const good = {
    iss: "https://accounts.google.com",
    aud: "cid.apps.googleusercontent.com",
    exp: 1_800_000_600,
    nonce: "n1",
    hd: "zerobit.example",
    email: "Owner@ZeroBit.example",
    email_verified: true,
  };

  it("すべて合っていれば、小文字のメールアドレスを返す", () => {
    expect(checkIdToken(good, expect_)).toEqual({ ok: true, email: "owner@zerobit.example" });
  });

  it.each([
    ["発行元が違う", { iss: "https://evil.example" }],
    ["宛先が違う", { aud: "other-client" }],
    ["期限切れ", { exp: 1_799_999_999 }],
    ["nonce が違う", { nonce: "n2" }],
    ["会社のアカウントではない", { hd: undefined }],
    ["会社のアカウントではない", { hd: "other.example" }],
    ["メールが確認されていない", { email_verified: "true" }],
    ["会社のアカウントではない", { email: "someone@gmail.com" }],
  ])("%s なら断る", (reason, patch) => {
    expect(checkIdToken({ ...good, ...patch }, expect_)).toEqual({ ok: false, reason });
  });

  it("JWT の中身を読む", () => {
    const payload = Buffer.from(JSON.stringify({ email: "a@b" })).toString("base64url");
    expect(decodeJwtPayload(`x.${payload}.y`)).toEqual({ email: "a@b" });
    expect(() => decodeJwtPayload("broken")).toThrow();
  });

  it("設定が足りなければ null。ドメインは小文字にそろえる", () => {
    expect(googleConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" })).toBeNull();
    expect(
      googleConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", AUTH_ALLOWED_DOMAIN: "ZeroBit.example", APP_URL: "https://zb.example/" }),
    ).toEqual({ clientId: "a", clientSecret: "b", domain: "zerobit.example", appUrl: "https://zb.example" });
  });

  it("Google へ送るURLに PKCE・state・nonce・会社のドメインが入る", () => {
    const config = { clientId: "a", clientSecret: "b", domain: "zerobit.example", appUrl: "http://localhost:3000" };
    const start = newOAuthStart("/trace");
    const url = new URL(authorizeUrl(config, start));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/callback");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("nonce")).toBe(start.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe(start.verifier);
    expect(url.searchParams.get("hd")).toBe("zerobit.example");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});

describe("ログイン後に戻る先", () => {
  it.each([
    ["/trace/ZB-2609-0118", "/trace/ZB-2609-0118"],
    ["/trace?q=2609", "/trace?q=2609"],
    ["https://evil.example", "/"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/\t/evil.example", "/"],
    ["/login", "/"],
    ["/auth/callback", "/"],
    [undefined, "/"],
  ])("%s → %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });
});
