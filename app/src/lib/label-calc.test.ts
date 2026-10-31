// 管理番号シールの中身（QR の URL）と、印刷画面の URL の値の確かめ方
import { describe, expect, it } from "vitest";
import { mgmtNoFromLabel, normalizeSearch } from "@/lib/codes";
import { LABEL_LENGTH_MM, MAX_UNITS, PLACEHOLDER_PUBLIC_URL, TAPES, isPlaceholderUrl, labelUrl, parseLabelRequest } from "@/lib/label-calc";

describe("QR に入れる URL", () => {
  it("ZB_PUBLIC_URL の後ろに /r/管理番号 を付ける（最後の / はそろえる）", () => {
    expect(labelUrl("https://zero-bit.jp", "ZB-2610-0045")).toBe("https://zero-bit.jp/r/ZB-2610-0045");
    expect(labelUrl("https://zero-bit.jp//", "ZB-2610-0045")).toBe("https://zero-bit.jp/r/ZB-2610-0045");
  });

  it("決まっていないときは仮の URL にして、仮だと分かる", () => {
    expect(labelUrl(undefined, "ZB-2610-0045")).toBe(`${PLACEHOLDER_PUBLIC_URL}/r/ZB-2610-0045`);
    expect(labelUrl("  ", "ZB-2610-0045")).toBe(`${PLACEHOLDER_PUBLIC_URL}/r/ZB-2610-0045`);
    expect(isPlaceholderUrl(undefined)).toBe(true);
    expect(isPlaceholderUrl("")).toBe(true);
    expect(isPlaceholderUrl("https://zerobit.example")).toBe(true);
    expect(isPlaceholderUrl("https://zero-bit.jp")).toBe(false);
  });

  it("24mm テープでは高さ 18mm まで刷れ、QR はその正方形でシールに収まる", () => {
    expect(TAPES[24].printable).toBe(18);
    expect(TAPES[24].printable).toBeLessThan(TAPES[24].tape);
    expect(LABEL_LENGTH_MM).toBeGreaterThan(TAPES[24].printable * 2);
  });
});

describe("シールの QR を読み取り機で読んだとき", () => {
  it("URL から管理番号を取り出す", () => {
    expect(mgmtNoFromLabel("https://zero-bit.jp/r/ZB-2610-0045")).toBe("ZB-2610-0045");
    expect(mgmtNoFromLabel("https://zerobit.example/r/zb-2610-0045?x=1")).toBe("ZB-2610-0045");
    // 日本語入力がオンのまま読んで全角になっても戻る
    expect(mgmtNoFromLabel("ｈｔｔｐｓ：／／ｚｅｒｏ－ｂｉｔ．ｊｐ／ｒ／ＺＢ－２６１０－００４５")).toBe("ZB-2610-0045");
  });

  it("URL でないもの、形の違うものは管理番号にしない", () => {
    expect(mgmtNoFromLabel("ZB-2610-0045")).toBeNull();
    expect(mgmtNoFromLabel("https://zero-bit.jp/r/ZB-2610-00451")).toBeNull();
    expect(mgmtNoFromLabel("https://zero-bit.jp/x/ZB-2610-0045")).toBeNull();
    expect(mgmtNoFromLabel("9MP4C0501")).toBeNull();
  });

  it("個体トレースの検索欄でも、QR を読めば管理番号で探す", () => {
    expect(normalizeSearch("https://zero-bit.jp/r/ZB-2610-0045")).toBe("ZB-2610-0045");
    expect(normalizeSearch("zb26100045")).toBe("ZB-2610-0045");
  });
});

describe("印刷画面の URL の値", () => {
  it("管理番号をそろえ、同じものは1つにし、おかしなものは捨てる", () => {
    const r = parseLabelRequest({ u: ["zb-2610-0045", "ZB-2610-0045", "ZB26100046", "DROP TABLE", "ZB-2610-0047,ZB-2610-0048"] });
    expect(r.mgmtNos).toEqual(["ZB-2610-0045", "ZB-2610-0046", "ZB-2610-0047", "ZB-2610-0048"]);
  });

  it("1つだけでも受け取る", () => {
    expect(parseLabelRequest({ u: "ZB-2610-0045", copies: "1" })).toEqual({ mgmtNos: ["ZB-2610-0045"], copies: 1 });
    expect(parseLabelRequest({})).toEqual({ mgmtNos: [], copies: 2 });
  });

  it("枚数は1〜4枚。それ以外はふつうの2枚（本体と箱）にする", () => {
    expect(parseLabelRequest({ copies: "4" }).copies).toBe(4);
    expect(parseLabelRequest({ copies: "5" }).copies).toBe(2);
    expect(parseLabelRequest({ copies: "0" }).copies).toBe(2);
    expect(parseLabelRequest({ copies: "1.5" }).copies).toBe(2);
    expect(parseLabelRequest({ copies: "abc" }).copies).toBe(2);
    expect(parseLabelRequest({ copies: ["3", "1"] }).copies).toBe(3);
  });

  it(`1回に刷れるのは ${MAX_UNITS} 台まで`, () => {
    const many = Array.from({ length: 80 }, (_, i) => `ZB-2611-${String(i + 1).padStart(4, "0")}`);
    expect(parseLabelRequest({ u: many }).mgmtNos).toHaveLength(MAX_UNITS);
  });
});
