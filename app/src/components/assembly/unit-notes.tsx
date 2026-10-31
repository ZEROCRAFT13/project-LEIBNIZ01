"use client";

import { useActionState, useState } from "react";
import { addNoteAction, removeNoteAction, type NoteState } from "@/app/assembly/actions";

type Note = { id: number; note: string; by: string | null };

// 個体のメモ。在庫を使わない作業や部品を文字で残す（LEDテープを追加、ケーブルを交換 など）
export function UnitNotes({ mgmtNo, notes, editable }: { mgmtNo: string; notes: Note[]; editable: boolean }) {
  const [addState, add, adding] = useActionState<NoteState, FormData>(addNoteAction, null);
  const [removeState, remove, removing] = useActionState<NoteState, FormData>(removeNoteAction, null);
  const [text, setText] = useState("");
  const [seen, setSeen] = useState(addState);
  if (addState !== seen) {
    setSeen(addState);
    if (addState?.ok) setText("");
  }
  const latest = [addState, removeState]
    .filter((s): s is NonNullable<NoteState> => s != null)
    .sort((a, b) => b.at - a.at)[0];

  if (!editable && notes.length === 0) return null;
  return (
    <section aria-label="メモ" className="flex flex-col gap-2 rounded-lg border border-stone-300 bg-white p-4">
      <h2 className="font-bold">メモ（部品として登録していないもの・作業）</h2>
      {notes.length > 0 && (
        <ul className="flex flex-col divide-y divide-stone-100 rounded-md border border-stone-200 text-sm">
          {notes.map((n) => (
            <li key={n.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1">{n.note}</span>
              {n.by && <span className="text-xs text-stone-500">{n.by}</span>}
              {editable && (
                <form action={remove}>
                  <input type="hidden" name="mgmtNo" value={mgmtNo} />
                  <input type="hidden" name="noteId" value={n.id} />
                  <button type="submit" disabled={removing} className="text-xs text-red-800 underline">
                    取り消す
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form action={add} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="mgmtNo" value={mgmtNo} />
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            メモを足す（お客様の名前や住所は書かない）
            <input
              name="note"
              value={text}
              maxLength={200}
              placeholder="例：LEDテープを追加"
              onChange={(e) => setText(e.target.value)}
              className="h-11 rounded-md border border-stone-400 bg-white px-3"
            />
          </label>
          <button
            type="submit"
            disabled={adding || text.trim() === ""}
            className="h-11 rounded-md bg-stone-800 px-4 font-bold text-white disabled:opacity-60"
          >
            残す
          </button>
        </form>
      )}
      {latest && (
        <p
          role={latest.ok ? "status" : "alert"}
          className={`rounded-md px-3 py-2 text-sm ${latest.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
        >
          {latest.message}
        </p>
      )}
    </section>
  );
}
