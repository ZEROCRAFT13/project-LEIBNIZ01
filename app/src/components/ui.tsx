import type { ReactNode } from "react";

// 画面で共通に使う小さな部品

type Tone = "gray" | "blue" | "green" | "amber" | "red";

const toneClass: Record<Tone, string> = {
  gray: "bg-stone-200 text-stone-800",
  blue: "bg-blue-100 text-blue-900",
  green: "bg-green-100 text-green-900",
  amber: "bg-amber-100 text-amber-950",
  red: "bg-red-100 text-red-900",
};

export function Tag({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${toneClass[tone]}`}>
      {children}
    </span>
  );
}

export function Card({
  title,
  aside,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-5 py-3">
          <h2 className="text-base font-bold">{title}</h2>
          {aside && <div className="text-sm text-stone-600">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading({ text = "読み込み中…" }: { text?: string }) {
  return <p className="py-10 text-center text-sm text-stone-500">{text}</p>;
}
