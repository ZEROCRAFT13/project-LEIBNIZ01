// 部品の型番・仕入先の入力の確かめ
import { describe, expect, it } from "vitest";
import { isValidJan, parsePartModelInput, parseSupplierInput } from "./master-calc";

describe("JANコード", () => {
  it.each([
    ["4006381333931", true], // 13桁
    ["73513537", true], // 8桁
    ["2000000000015", true], // ダミーデータのもの
    ["4006381333932", false], // 最後の1桁がちがう（読み間違い・打ち間違い）
    ["400638133393", false], // 12桁
    ["ABCDEFGH", false],
  ])("%s → %s", (code, ok) => {
    expect(isValidJan(code)).toBe(ok);
  });
});

describe("部品の型番の入力", () => {
  const good = {
    category: "gpu",
    maker: " メーカーA ",
    modelNo: "rtx5070-a12g",
    name: "GeForce RTX 5070 12GB",
    janCode: "4006-3813-33931",
    serialRequired: "on",
    keepBox: "on",
    makerWarrantyMonths: "２４",
  };

  it("そろえて返す（型番は大文字、全角数字は半角、JANのハイフンは取る）", () => {
    expect(parsePartModelInput(good)).toEqual({
      ok: true,
      value: {
        category: "gpu",
        maker: "メーカーA",
        modelNo: "RTX5070-A12G",
        name: "GeForce RTX 5070 12GB",
        janCode: "4006381333931",
        serialRequired: true,
        keepBox: true,
        makerWarrantyMonths: 24,
        active: true,
      },
    });
  });

  it("チェックボックスを外したものは false。空の項目は null", () => {
    const r = parsePartModelInput({ ...good, serialRequired: undefined, keepBox: undefined, janCode: "", makerWarrantyMonths: "" });
    expect(r.ok && r.value).toMatchObject({ serialRequired: false, keepBox: false, janCode: null, makerWarrantyMonths: null });
  });

  it("「使っている」を外すと使わないにできる（変更のとき）", () => {
    const r = parsePartModelInput({ ...good, active: undefined, id: "3" });
    expect(r.ok && r.value.active).toBe(true); // active の欄がない（追加のとき）は使う
    const r2 = parsePartModelInput({ ...good, active: "" });
    expect(r2.ok && r2.value.active).toBe(false);
  });

  it.each([
    [{ category: "toaster" }, "種類を選んでください。"],
    [{ maker: " " }, "メーカーを入れてください（60文字まで）。"],
    [{ modelNo: "" }, "型番を入れてください（60文字まで）。"],
    [{ name: "x".repeat(101) }, "名前を入れてください（100文字まで）。"],
    [{ janCode: "4006381333932" }, "JANコードが正しくありません（8桁か13桁。最後の1桁が合いません）。"],
    [{ makerWarrantyMonths: "1年" }, "メーカー保証は月数（0〜240）で入れてください。"],
    [{ makerWarrantyMonths: "300" }, "メーカー保証は月数（0〜240）で入れてください。"],
  ])("%o → 「%s」", (patch, message) => {
    const r = parsePartModelInput({ ...good, ...patch });
    expect(!r.ok && r.errors).toContain(message);
  });
});

describe("仕入先の入力", () => {
  const good = {
    name: " Joshin ",
    kind: "shop",
    invoiceRegNo: "t-1234567890123",
    website: "https://joshin.example/top",
    rmaContact: "",
    notes: "  ",
  };

  it("そろえて返す", () => {
    expect(parseSupplierInput(good)).toEqual({
      ok: true,
      value: {
        name: "Joshin",
        kind: "shop",
        invoiceRegNo: "T1234567890123",
        website: "https://joshin.example/top",
        rmaContact: null,
        notes: null,
      },
    });
  });

  it.each([
    [{ name: "" }, "仕入先の名前を入れてください（60文字まで）。"],
    [{ kind: "bank" }, "種類を選んでください。"],
    [{ invoiceRegNo: "T123" }, "インボイス登録番号は「T」と13桁の数字です。"],
    [{ website: "javascript:alert(1)" }, "サイトのURLは https:// から入れてください。"],
    [{ website: "joshin.example" }, "サイトのURLは https:// から入れてください。"],
    [{ notes: "x".repeat(501) }, "メモが長すぎます（500文字まで）。"],
  ])("%o → 「%s」", (patch, message) => {
    const r = parseSupplierInput({ ...good, ...patch });
    expect(!r.ok && r.errors).toContain(message);
  });
});
