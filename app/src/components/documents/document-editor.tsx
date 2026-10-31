"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  linkPurchaseAction,
  saveDocumentMetaAction,
  unlinkPurchaseAction,
  type DocState,
} from "@/app/documents/actions";
import { DOCUMENT_KINDS } from "@/lib/document-calc";
import { documentKindLabel } from "@/lib/labels";

type Meta = {
  kind: string;
  issuedOn: string | null;
  counterparty: string | null;
  amount: number | null;
  invoiceRegNo: string | null;
  reviewStatus: string;
};

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";

function Message({ state }: { state: DocState }) {
  if (!state) return null;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className={`rounded-md px-4 py-2 text-sm ${state.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
    >
      {state.message}
    </p>
  );
}

// 書類の項目（電子帳簿保存法で探せるように、日付・取引先・金額）を入れて、確認済みにする
export function DocumentMetaForm({ documentId, meta }: { documentId: number; meta: Meta }) {
  const [state, action, pending] = useActionState<DocState, FormData>(saveDocumentMetaAction, null);
  const [form, setForm] = useState({
    kind: meta.kind,
    issuedOn: meta.issuedOn ?? "",
    counterparty: meta.counterparty ?? "",
    amount: meta.amount === null ? "" : String(meta.amount),
    invoiceRegNo: meta.invoiceRegNo ?? "",
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="documentId" value={documentId} />
      <label className="flex flex-col gap-1 text-sm font-medium">
        種類
        <select name="kind" value={form.kind} onChange={(e) => set({ kind: e.target.value })} className={inputClass}>
          {DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {documentKindLabel[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        日付（発行日・購入日）
        <input
          name="issuedOn"
          type="date"
          value={form.issuedOn}
          onChange={(e) => set({ issuedOn: e.target.value })}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        取引先
        <input
          name="counterparty"
          value={form.counterparty}
          maxLength={100}
          onChange={(e) => set({ counterparty: e.target.value })}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        金額（税込・円）
        <input
          name="amount"
          inputMode="numeric"
          value={form.amount}
          onChange={(e) => set({ amount: e.target.value })}
          className={`${inputClass} font-mono`}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        インボイス登録番号（あれば）
        <input
          name="invoiceRegNo"
          value={form.invoiceRegNo}
          placeholder="T1234567890123"
          onChange={(e) => set({ invoiceRegNo: e.target.value })}
          className={`${inputClass} font-mono`}
        />
      </label>
      <Message state={state} />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="done"
          value="1"
          disabled={pending}
          className="h-12 rounded-md bg-blue-800 px-5 font-bold text-white disabled:opacity-60"
        >
          {meta.reviewStatus === "done" ? "直して保存（確認済みのまま）" : "確認済みにする"}
        </button>
        {meta.reviewStatus !== "done" && (
          <button
            type="submit"
            name="done"
            value="0"
            disabled={pending}
            className="h-12 rounded-md border border-stone-400 px-5 disabled:opacity-60"
          >
            途中で保存
          </button>
        )}
      </div>
    </form>
  );
}

// 仕入れとのひもづけ
export function PurchaseLinks({
  documentId,
  linked,
  options,
}: {
  documentId: number;
  linked: { id: number; label: string }[];
  options: { id: number; label: string }[];
}) {
  const [linkState, link, linking] = useActionState<DocState, FormData>(linkPurchaseAction, null);
  const [unlinkState, unlink, unlinking] = useActionState<DocState, FormData>(unlinkPurchaseAction, null);
  const [selected, setSelected] = useState("");
  const latest = [linkState, unlinkState]
    .filter((s): s is NonNullable<DocState> => s != null)
    .sort((a, b) => b.at - a.at)[0];
  const linkedIds = new Set(linked.map((l) => l.id));

  return (
    <div className="flex flex-col gap-3">
      {linked.length === 0 ? (
        <p className="text-sm text-stone-600">まだどの仕入れにもひもづいていません。</p>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100 rounded-md border border-stone-200 text-sm">
          {linked.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <Link href={`/purchases/${p.id}`} className="text-blue-800 underline">
                仕入れ #{p.id}
              </Link>
              <span>{p.label}</span>
              <form action={unlink} className="ml-auto">
                <input type="hidden" name="documentId" value={documentId} />
                <input type="hidden" name="purchaseId" value={p.id} />
                <button type="submit" disabled={unlinking} className="text-xs text-red-800 underline">
                  外す
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={link} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="documentId" value={documentId} />
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          仕入れにひもづける
          <select
            name="purchaseId"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className={inputClass}
          >
            <option value="">選んでください（最近の仕入れ）</option>
            {options
              .filter((o) => !linkedIds.has(o.id))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  #{o.id} {o.label}
                </option>
              ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={linking || selected === ""}
          className="h-11 rounded-md bg-stone-800 px-4 font-bold text-white disabled:opacity-60"
        >
          ひもづける
        </button>
      </form>
      <Message state={latest ?? null} />
    </div>
  );
}
