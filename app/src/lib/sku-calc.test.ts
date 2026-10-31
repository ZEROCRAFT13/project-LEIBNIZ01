// 機種と枠の入力の確かめ
import { describe, expect, it } from "vitest";
import { DEFAULT_SLOTS, normalizeSkuCode, parseSkuInput, parseSlotInput } from "./sku-calc";

describe("機種", () => {
  it("機種コードは大文字・半角にそろえる", () => {
    expect(normalizeSkuCode(" zb－g5070－r7 ")).toBe("ZB-G5070-R7");
  });

  it("正しい入力をそろえて返す（名前の全角はそのまま）", () => {
    expect(parseSkuInput({ code: "zb-g5080-r9", name: " ゲーミングPC（RTX 5080） ", listPrice: "４９９,８００" })).toEqual({
      ok: true,
      value: { code: "ZB-G5080-R9", name: "ゲーミングPC（RTX 5080）", listPrice: 499800, active: true },
    });
  });

  it.each([
    [{ code: "ZB" }, "機種コードは英大文字・数字・ハイフンで3〜30文字にしてください（例 ZB-G5070-R7）。"],
    [{ code: "ZB G5070" }, undefined],
    [{ code: "-ZB-1" }, "機種コードは英大文字・数字・ハイフンで3〜30文字にしてください（例 ZB-G5070-R7）。"],
    [{ name: "" }, "機種の名前を入れてください（100文字まで）。"],
    [{ listPrice: "1.5" }, "定価（税込）は円の数字で入れてください。"],
  ])("%o → %s", (patch, message) => {
    const r = parseSkuInput({ code: "ZB-TEST", name: "テスト", listPrice: "", ...patch });
    if (message) expect(!r.ok && r.errors).toContain(message);
    else expect(r.ok).toBe(true); // 空白は取ってそろえる
  });

  it("「販売・組立に使う」を外せる", () => {
    const r = parseSkuInput({ code: "ZB-TEST", name: "テスト", active: "" });
    expect(r.ok && r.value.active).toBe(false);
  });
});

describe("枠", () => {
  it("名前は大文字・空白やハイフンは _ にそろえる", () => {
    expect(parseSlotInput({ slot: "fan front", category: "fan", qty: "３" })).toEqual({
      ok: true,
      value: { slot: "FAN_FRONT", category: "fan", qty: 3, required: true, anyPart: false },
    });
  });

  it("「付けなくてもよい」と自由枠（種類 any）", () => {
    expect(parseSlotInput({ slot: "FAN", category: "fan", qty: "3", optional: "on" })).toMatchObject({
      ok: true,
      value: { required: false, anyPart: false },
    });
    expect(parseSlotInput({ slot: "EXTRA", category: "any", qty: "5", optional: "on" })).toEqual({
      ok: true,
      value: { slot: "EXTRA", category: "other", qty: 5, required: false, anyPart: true },
    });
  });

  it.each([
    [{ slot: "1FAN" }, "枠の名前は英大文字で始め、英大文字・数字・_ で20文字までにしてください（例 FAN_FRONT）。"],
    [{ slot: "ファン" }, "枠の名前は英大文字で始め、英大文字・数字・_ で20文字までにしてください（例 FAN_FRONT）。"],
    [{ category: "toaster" }, "枠に入れる部品の種類を選んでください。"],
    [{ qty: "0" }, "数は1〜20にしてください。"],
    [{ qty: "21" }, "数は1〜20にしてください。"],
  ])("%o → 「%s」", (patch, message) => {
    const r = parseSlotInput({ slot: "FAN", category: "fan", qty: "1", ...patch });
    expect(!r.ok && r.errors).toContain(message);
  });

  it("ひな形はふつうのゲーミングPCの9枠と、付けなくてもよいケースファン・自由枠", () => {
    expect(DEFAULT_SLOTS.map((s) => s.slot)).toEqual([
      "CPU", "GPU", "MB", "MEMORY", "SSD", "PSU", "COOLER", "CASE", "OS", "FAN", "EXTRA",
    ]);
    expect(DEFAULT_SLOTS.filter((s) => !s.required).map((s) => s.slot)).toEqual(["FAN", "EXTRA"]);
  });
});
