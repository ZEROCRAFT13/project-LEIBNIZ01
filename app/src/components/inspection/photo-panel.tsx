"use client";

import { useActionState, useRef, useState } from "react";
import { addPhotoAction, removePhotoAction, type InspectState } from "@/app/inspection/actions";
import { PHOTO_KINDS, REQUIRED_PHOTO, photoHint, photoKindLabel, type PhotoKind, type Stage } from "@/lib/inspection-calc";

export type PanelPhoto = { id: number; kind: PhotoKind; takenBy: string; takenAt: string };

// 今の段階の写真を撮る・見る・取り消す。スマホではカメラが開く
export function PhotoPanel({ mgmtNo, stage, photos }: { mgmtNo: string; stage: Stage; photos: PanelPhoto[] }) {
  const kinds = PHOTO_KINDS[stage];
  const required = REQUIRED_PHOTO[stage];
  const [kind, setKind] = useState<PhotoKind>(kinds[0]);
  const [state, add, adding] = useActionState<InspectState, FormData>(addPhotoAction, null);
  const [removeState, remove, removing] = useActionState<InspectState, FormData>(removePhotoAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const missing = required !== null && !photos.some((p) => p.kind === required);
  const shown = removeState && (!state || removeState.at > state.at) ? removeState : state;

  return (
    <section aria-labelledby="photos-title" className="flex flex-col gap-3 rounded-lg border border-stone-300 bg-white p-4">
      <h2 id="photos-title" className="font-bold">
        写真
        {required ? (
          <span className={`ml-2 text-sm font-medium ${missing ? "text-red-800" : "text-green-800"}`}>
            {missing ? `「${photoKindLabel[required]}」が要ります` : `「${photoKindLabel[required]}」あり`}
          </span>
        ) : (
          <span className="ml-2 text-sm font-medium text-stone-600">（この段階は任意）</span>
        )}
      </h2>

      <form ref={formRef} action={add} className="flex flex-col gap-2">
        <input type="hidden" name="mgmtNo" value={mgmtNo} />
        <input type="hidden" name="stage" value={stage} />
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">写真の種類</legend>
          {kinds.map((k) => (
            <label
              key={k}
              className={`flex h-10 cursor-pointer items-center rounded-md border px-3 text-sm ${
                kind === k ? "border-blue-700 bg-blue-50 font-bold text-blue-900" : "border-stone-300"
              }`}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="sr-only"
              />
              {photoKindLabel[k]}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-stone-600">{photoHint[kind]}</p>
        <label
          className={`flex h-12 cursor-pointer items-center justify-center rounded-md bg-blue-700 font-bold text-white ${
            adding ? "opacity-60" : ""
          }`}
        >
          {adding ? "送っています…" : `${photoKindLabel[kind]}を撮る・選ぶ`}
          <input
            type="file"
            name="photo"
            accept="image/jpeg,image/png,image/webp,image/heic,image/*"
            capture="environment"
            disabled={adding}
            className="sr-only"
            onChange={(e) => {
              if (e.currentTarget.files?.length) formRef.current?.requestSubmit();
            }}
          />
        </label>
      </form>

      {shown && (
        <p
          role={shown.ok ? "status" : "alert"}
          className={`rounded-md px-3 py-2 text-sm ${shown.ok ? "bg-green-100 text-green-950" : "bg-red-100 text-red-900"}`}
        >
          {shown.message}
        </p>
      )}

      {photos.length > 0 && (
        <ul aria-label="撮った写真" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((p) => (
            <li key={p.id} className="flex flex-col gap-1 text-xs text-stone-700">
              <a href={`/inspection/photos/${p.id}`} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- ログインした人だけが見る写真。最適化の対象にしない */}
                <img
                  src={`/inspection/photos/${p.id}`}
                  alt={`${photoKindLabel[p.kind]}（${p.takenAt}）`}
                  className="aspect-[4/3] w-full rounded border border-stone-200 bg-stone-100 object-cover"
                />
              </a>
              <span className="font-medium">{photoKindLabel[p.kind]}</span>
              <span>
                {p.takenAt}・{p.takenBy}
              </span>
              <form action={remove}>
                <input type="hidden" name="mgmtNo" value={mgmtNo} />
                <input type="hidden" name="photoId" value={p.id} />
                <button type="submit" disabled={removing} className="text-red-800 underline">
                  取り消す
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
