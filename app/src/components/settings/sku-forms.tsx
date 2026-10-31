"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  addOptionAction,
  addSlotAction,
  amazonListingsAction,
  createSkuAction,
  removeOptionAction,
  removeSlotAction,
  slotQtyAction,
  slotRequiredAction,
  updateSkuAction,
  type SkuState,
} from "@/app/settings/skus/actions";
import { label, partCategoryLabel, slotLabel } from "@/lib/labels";
import { PART_CATEGORIES } from "@/lib/master-calc";
import { amazonFulfillmentLabel, neededListings, type AmazonFulfillment } from "@/lib/sku-calc";

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";
const buttonClass = "h-11 rounded-md bg-blue-800 px-4 font-bold text-white disabled:opacity-60";

function Message({ state }: { state: SkuState }) {
  if (!state) return null;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className={`rounded-md px-3 py-2 text-sm ${state.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
    >
      {state.message}
    </p>
  );
}

function latest(...states: SkuState[]): SkuState {
  return states.filter((s): s is NonNullable<SkuState> => s != null).sort((a, b) => b.at - a.at)[0] ?? null;
}

// 新しい機種
export function NewSkuForm({ skus }: { skus: { id: number; code: string; name: string }[] }) {
  const [state, action, pending] = useActionState<SkuState, FormData>(createSkuAction, null);
  const [v, setV] = useState({ code: "", name: "", listPrice: "", copyFrom: "" });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          機種コード（あとから変えられません）
          <input
            name="code"
            value={v.code}
            placeholder="ZB-G5070-R7"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ code: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          名前
          <input
            name="name"
            value={v.name}
            maxLength={100}
            onChange={(e) => set({ name: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          定価（税込・あれば）
          <input
            name="listPrice"
            value={v.listPrice}
            inputMode="numeric"
            onChange={(e) => set({ listPrice: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          もとにする機種（枠と使ってよい型番を写す）
          <select
            name="copyFrom"
            value={v.copyFrom}
            onChange={(e) => set({ copyFrom: e.target.value })}
            className={inputClass}
          >
            <option value="">使わない（CPU〜OS の空の枠で作る）</option>
            {skus.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Message state={state} />
      <button type="submit" disabled={pending} className={`${buttonClass} h-12 w-fit px-6`}>
        {pending ? "作成中…" : "機種を作る"}
      </button>
    </form>
  );
}

// 機種の名前・定価・使うかどうか
export function SkuHeaderForm({
  sku,
}: {
  sku: { id: number; code: string; name: string; listPrice: number | null; active: boolean };
}) {
  const [state, action, pending] = useActionState<SkuState, FormData>(updateSkuAction, null);
  const [v, setV] = useState({
    name: sku.name,
    listPrice: sku.listPrice === null ? "" : String(sku.listPrice),
    active: sku.active,
  });
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="skuId" value={sku.id} />
      <input type="hidden" name="code" value={sku.code} />
      <input type="hidden" name="back" value={`/settings/skus/${sku.id}`} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          名前
          <input
            name="name"
            value={v.name}
            maxLength={100}
            onChange={(e) => setV((x) => ({ ...x, name: e.target.value }))}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          定価（税込）
          <input
            name="listPrice"
            value={v.listPrice}
            inputMode="numeric"
            onChange={(e) => setV((x) => ({ ...x, listPrice: e.target.value }))}
            className={`${inputClass} w-36 font-mono`}
          />
        </label>
        <label className="flex h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="active"
            checked={v.active}
            onChange={(e) => setV((x) => ({ ...x, active: e.target.checked }))}
            className="h-5 w-5"
          />
          販売・組立に使う
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          保存
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

type Option = { partModelId: number; name: string; maker: string; modelNo: string; active: boolean; inStock: number };
type Model = { id: number; category: string; maker: string; modelNo: string; name: string };

// 1つの枠：数、使ってよい型番、型番を足す、枠を消す
export function SlotCard({
  skuId,
  slot,
  models,
  locked,
}: {
  skuId: number;
  slot: {
    id: number;
    slot: string;
    category: string;
    qty: number;
    required: boolean;
    anyPart: boolean;
    options: Option[];
  };
  models: Model[];
  locked: boolean;
}) {
  const [reqState, setRequired, settingRequired] = useActionState<SkuState, FormData>(slotRequiredAction, null);
  const [addState, add, adding] = useActionState<SkuState, FormData>(addOptionAction, null);
  const [removeState, remove, removing] = useActionState<SkuState, FormData>(removeOptionAction, null);
  const [qtyState, setQty, settingQty] = useActionState<SkuState, FormData>(slotQtyAction, null);
  const [delState, del, deleting] = useActionState<SkuState, FormData>(removeSlotAction, null);
  const [pick, setPick] = useState("");
  const [qty, setQtyValue] = useState(String(slot.qty));
  // 足せたら選択を空に戻す（足した型番は選択肢から消えるため）
  const [seen, setSeen] = useState(addState);
  if (addState !== seen) {
    setSeen(addState);
    if (addState?.ok) setPick("");
  }
  const back = `/settings/skus/${skuId}`;
  const inSlot = new Set(slot.options.map((o) => o.partModelId));
  const candidates = models.filter((m) => m.category === slot.category && !inSlot.has(m.id));

  return (
    <section
      aria-label={`枠 ${slot.slot}`}
      className={`flex flex-col gap-3 rounded-lg border bg-white p-4 ${
        slot.options.length === 0 && slot.required && !slot.anyPart ? "border-amber-500" : "border-stone-300"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">
          {label(slotLabel, slot.slot)}
          {label(slotLabel, slot.slot) !== slot.slot && (
            <span className="ml-2 font-mono text-sm font-normal text-stone-500">{slot.slot}</span>
          )}
          {!slot.anyPart && label(partCategoryLabel, slot.category) !== label(slotLabel, slot.slot) && (
            <span className="ml-2 text-sm font-normal text-stone-600">
              （{label(partCategoryLabel, slot.category)}）
            </span>
          )}
          <span
            className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${
              slot.required ? "bg-stone-800 text-white" : "bg-stone-200 text-stone-800"
            }`}
          >
            {slot.required ? "必ず付ける" : "付けなくてもよい"}
          </span>
          {slot.anyPart && (
            <span className="ml-1 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900">自由枠</span>
          )}
        </h3>
        <form action={setQty} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="slotId" value={slot.id} />
          <input type="hidden" name="back" value={back} />
          <label className="flex items-center gap-1">
            数
            <input
              name="qty"
              value={qty}
              inputMode="numeric"
              aria-label={`${slot.slot} の数`}
              onChange={(e) => setQtyValue(e.target.value)}
              className="h-9 w-14 rounded-md border border-stone-400 px-2 text-right"
            />
          </label>
          {qty !== String(slot.qty) && (
            <button type="submit" disabled={settingQty} className="h-9 rounded-md border border-stone-400 px-3">
              変える
            </button>
          )}
        </form>
      </div>

      {slot.anyPart ? (
        <p className="text-sm text-stone-700">
          登録済みの部品なら、種類を問わず {slot.qty}
          個まで付けられます（Wi-Fiカード、追加のSSDなど）。型番を決める必要はありません。
        </p>
      ) : slot.options.length === 0 ? (
        <p className={`text-sm ${slot.required ? "text-amber-900" : "text-stone-600"}`}>
          {slot.required
            ? "使ってよい型番がありません。この枠の部品を組立で読むと止まります。"
            : "使ってよい型番がまだありません（付けない機種なら、このままで大丈夫です）。"}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100 rounded-md border border-stone-200 text-sm">
          {slot.options.map((o) => (
            <li
              key={o.partModelId}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${o.active ? "" : "opacity-60"}`}
            >
              <Link href={`/settings/parts/${o.partModelId}`} className="text-blue-800 underline">
                {o.name}
              </Link>
              <span className="font-mono text-xs text-stone-600">
                {o.maker} {o.modelNo}
              </span>
              <span className="text-xs text-stone-600">在庫 {o.inStock}</span>
              {!o.active && <span className="text-xs">（使わない型番）</span>}
              <form action={remove} className="ml-auto">
                <input type="hidden" name="slotId" value={slot.id} />
                <input type="hidden" name="partModelId" value={o.partModelId} />
                <input type="hidden" name="back" value={back} />
                <button type="submit" disabled={removing} className="text-xs text-red-800 underline">
                  外す
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {!slot.anyPart && (
        <form action={add} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="slotId" value={slot.id} />
          <input type="hidden" name="back" value={back} />
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm">
            使ってよい型番を足す
            <select
              name="partModelId"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              aria-label={`${slot.slot} に足す型番`}
              className={inputClass}
            >
              <option value="">
                {candidates.length === 0
                  ? `足せる${label(partCategoryLabel, slot.category)}の型番がありません`
                  : "選んでください"}
              </option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}（{m.maker} {m.modelNo}）
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={adding || pick === ""} className={buttonClass}>
            足す
          </button>
        </form>
      )}

      <form action={setRequired} className="text-sm">
        <input type="hidden" name="slotId" value={slot.id} />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="required" value={slot.required ? "0" : "1"} />
        <button type="submit" disabled={settingRequired} className="text-blue-800 underline">
          {slot.required ? "「付けなくてもよい」にする" : "「必ず付ける」にする（Amazon 用など、構成を固定する機種）"}
        </button>
      </form>

      <Message state={latest(addState, removeState, qtyState, delState, reqState)} />

      {!locked && (
        <details className="text-sm">
          <summary className="cursor-pointer text-red-800">この枠を消す</summary>
          <form action={del} className="mt-2">
            <input type="hidden" name="slotId" value={slot.id} />
            <input type="hidden" name="back" value={back} />
            <button type="submit" disabled={deleting} className="h-10 rounded-md bg-red-700 px-4 font-bold text-white">
              枠「{slot.slot}」を消す
            </button>
          </form>
        </details>
      )}
    </section>
  );
}

// 枠を足す（ファンなど）
export function AddSlotForm({ skuId }: { skuId: number }) {
  const [state, action, pending] = useActionState<SkuState, FormData>(addSlotAction, null);
  const empty = { slot: "", category: "", qty: "1", optional: false };
  const [v, setV] = useState(empty);
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  // 足せたら欄を空に戻す
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setV(empty);
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="skuId" value={skuId} />
      <input type="hidden" name="back" value={`/settings/skus/${skuId}`} />
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="self-center text-stone-600">よく使う枠：</span>
        <button
          type="button"
          onClick={() => setV({ slot: "FAN", category: "fan", qty: "3", optional: true })}
          className="h-9 rounded-md border border-stone-400 px-3"
        >
          ケースファン
        </button>
        <button
          type="button"
          onClick={() => setV({ slot: "EXTRA", category: "any", qty: "5", optional: true })}
          className="h-9 rounded-md border border-stone-400 px-3"
        >
          自由枠（何でも）
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          枠の名前（英大文字）
          <input
            name="slot"
            value={v.slot}
            placeholder="FAN_FRONT"
            autoComplete="off"
            onChange={(e) => set({ slot: e.target.value })}
            className={`${inputClass} w-44 font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          部品の種類
          <select
            name="category"
            value={v.category}
            onChange={(e) => set({ category: e.target.value })}
            className={inputClass}
          >
            <option value="">選んでください</option>
            {PART_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {partCategoryLabel[c]}
              </option>
            ))}
            <option value="any">なんでも（自由枠）</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          数（自由枠と「付けなくてもよい」枠は上限）
          <input
            name="qty"
            value={v.qty}
            inputMode="numeric"
            onChange={(e) => set({ qty: e.target.value })}
            className={`${inputClass} w-20 text-right`}
          />
        </label>
        <label className="flex h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="optional"
            checked={v.optional}
            onChange={(e) => set({ optional: e.target.checked })}
            className="h-5 w-5"
          />
          付けなくてもよい
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          枠を足す
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

// 型番の画面：この型番を使ってよい機種の枠と、足せる枠
export function PartSkuPanel({
  partModelId,
  using,
  available,
}: {
  partModelId: number;
  using: { slotId: number; skuId: number; skuCode: string; slot: string }[];
  available: { slotId: number; skuId: number; skuCode: string; slot: string }[];
}) {
  const [addState, add, adding] = useActionState<SkuState, FormData>(addOptionAction, null);
  const [removeState, remove, removing] = useActionState<SkuState, FormData>(removeOptionAction, null);
  const [pick, setPick] = useState("");
  const [seen, setSeen] = useState(addState);
  if (addState !== seen) {
    setSeen(addState);
    if (addState?.ok) setPick("");
  }
  const back = `/settings/parts/${partModelId}`;
  return (
    <div className="flex flex-col gap-3">
      {using.length === 0 ? (
        <p className="text-sm text-amber-900">
          まだどの機種でも使えません。組立で使うには、下で機種の枠に足してください。
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100 rounded-md border border-stone-200 text-sm">
          {using.map((u) => (
            <li key={u.slotId} className="flex items-center gap-3 px-3 py-2">
              <Link href={`/settings/skus/${u.skuId}`} className="font-mono text-blue-800 underline">
                {u.skuCode}
              </Link>
              <span>{label(slotLabel, u.slot)}</span>
              <form action={remove} className="ml-auto">
                <input type="hidden" name="slotId" value={u.slotId} />
                <input type="hidden" name="partModelId" value={partModelId} />
                <input type="hidden" name="back" value={back} />
                <button type="submit" disabled={removing} className="text-xs text-red-800 underline">
                  外す
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <form action={add} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="partModelId" value={partModelId} />
          <input type="hidden" name="back" value={back} />
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm">
            機種の枠に足す
            <select name="slotId" value={pick} onChange={(e) => setPick(e.target.value)} className={inputClass}>
              <option value="">選んでください</option>
              {available.map((a) => (
                <option key={a.slotId} value={a.slotId}>
                  {a.skuCode} の {label(slotLabel, a.slot)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={adding || pick === ""} className={buttonClass}>
            足す
          </button>
        </form>
      )}
      <Message state={latest(addState, removeState)} />
    </div>
  );
}

type Listing = { fulfillment: "fba" | "fbm"; sellerSku: string; asin: string; active: boolean };

// Amazon の出荷方法と、FBA 用・自社出荷用の出品（セラー SKU と ASIN）
export function AmazonListingsForm({
  skuId,
  fulfillment,
  listings,
}: {
  skuId: number;
  fulfillment: AmazonFulfillment | null;
  listings: Listing[];
}) {
  const [state, action, pending] = useActionState<SkuState, FormData>(amazonListingsAction, null);
  const current = (k: "fba" | "fbm") => listings.find((l) => l.fulfillment === k && l.active);
  const [v, setV] = useState({
    fulfillment: (fulfillment ?? "none") as AmazonFulfillment | "none",
    fbaSellerSku: current("fba")?.sellerSku ?? "",
    fbaAsin: current("fba")?.asin ?? "",
    fbmSellerSku: current("fbm")?.sellerSku ?? "",
    fbmAsin: current("fbm")?.asin ?? "",
  });
  const needed = neededListings(v.fulfillment === "none" ? null : v.fulfillment);
  const stopped = listings.filter((l) => !l.active);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="skuId" value={skuId} />
      <input type="hidden" name="back" value={`/settings/skus/${skuId}`} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">出荷方法</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["fba", "fbm", "both", "none"] as const).map((f) => (
            <label
              key={f}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                v.fulfillment === f ? "border-blue-700 bg-blue-50 font-bold" : "border-stone-300"
              }`}
            >
              <input
                type="radio"
                name="fulfillment"
                value={f}
                checked={v.fulfillment === f}
                onChange={() => setV((x) => ({ ...x, fulfillment: f }))}
              />
              {amazonFulfillmentLabel[f]}
            </label>
          ))}
        </div>
        <p className="text-xs text-stone-600">
          FBA：台数の出る機種。補充の計算と FBA 納品の対象になります。自社出荷：高額で台数の少ない機種など。注文ごとに管理番号を読んで出荷します。
          両方：ふだんは FBA で売り、FBA の在庫が切れている間だけ自社出荷でも売ります。
        </p>
      </fieldset>

      {(["fba", "fbm"] as const).map((k) => {
        const use = needed.includes(k);
        // 出荷方法で使わない側は、登録してあるときだけ見せる（切り替えて戻すことがあるので消さない）
        if (!use && !current(k)) return null;
        return (
          <fieldset key={k} className={`flex flex-col gap-2 ${use ? "" : "opacity-60"}`}>
            <legend className="mb-1 text-sm font-medium">
              {k === "fba" ? "FBA 用の出品" : "自社出荷用の出品"}
              {!use && <span className="ml-2 text-xs font-normal">（今の出荷方法では使いません）</span>}
            </legend>
            <div className="flex flex-wrap gap-3">
              <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
                セラー SKU
                <input
                  name={`${k}SellerSku`}
                  value={k === "fba" ? v.fbaSellerSku : v.fbmSellerSku}
                  onChange={(e) => {
                    const val = e.target.value;
                    setV((x) => (k === "fba" ? { ...x, fbaSellerSku: val } : { ...x, fbmSellerSku: val }));
                  }}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={k === "fba" ? "例 ZB-G5070-R7-FBA" : "例 ZB-G5070-R7-FBM"}
                  className={`${inputClass} font-mono`}
                />
              </label>
              <label className="flex w-44 flex-col gap-1 text-sm">
                ASIN
                <input
                  name={`${k}Asin`}
                  value={k === "fba" ? v.fbaAsin : v.fbmAsin}
                  onChange={(e) => {
                    const val = e.target.value;
                    setV((x) => (k === "fba" ? { ...x, fbaAsin: val } : { ...x, fbmAsin: val }));
                  }}
                  maxLength={10}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="B0XXXXXXXX"
                  className={`${inputClass} font-mono uppercase`}
                />
              </label>
            </div>
            {use && !(k === "fba" ? v.fbaSellerSku : v.fbmSellerSku) && (
              <p className="text-xs text-amber-900">まだ出品していなければ空のままで大丈夫です（あとで登録します）。</p>
            )}
          </fieldset>
        );
      })}
      <p className="text-xs text-stone-600">
        セラー SKU は、セラーセントラルに登録したとおりに書きます（大文字・小文字も同じに）。空にして保存すると、その出品を止めます（記録は残ります）。
      </p>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass}>
          保存
        </button>
      </div>
      <Message state={state} />
      {stopped.length > 0 && (
        <details className="text-sm text-stone-600">
          <summary className="cursor-pointer">止めた出品（{stopped.length}）</summary>
          <ul className="mt-1 list-disc pl-5">
            {stopped.map((l) => (
              <li key={`${l.fulfillment}-${l.sellerSku}`} className="font-mono">
                {l.fulfillment === "fba" ? "FBA" : "自社出荷"}・{l.sellerSku}・{l.asin}
              </li>
            ))}
          </ul>
        </details>
      )}
    </form>
  );
}
