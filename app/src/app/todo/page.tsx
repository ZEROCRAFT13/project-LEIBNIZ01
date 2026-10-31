import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AddTaskForm, FinishTaskForm } from "@/components/todo/forms";
import { Card, Loading, Tag } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { query } from "@/lib/db";
import { ymd, ymdHm } from "@/lib/format";
import { dueGroup, dueGroupLabel, orderNextStep, type DueGroup } from "@/lib/task-calc";
import { listOpenTasks, listRecentlyFinished, type TaskRow } from "@/lib/tasks";

export const metadata: Metadata = { title: "ToDo | ZERO-BIT" };

export default function TodoPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">ToDo</h1>
      <Suspense fallback={<Loading />}>
        <Todo />
      </Suspense>
    </main>
  );
}

async function Todo() {
  const viewer = await requireUser("/todo");
  const [open, finished, roles] = await Promise.all([
    listOpenTasks(viewer.roles),
    listRecentlyFinished(viewer.roles),
    query<{ code: string; name: string }>(`SELECT code, name FROM core.roles WHERE code = ANY($1) ORDER BY code`, [viewer.roles]),
  ]);
  const groups: DueGroup[] = ["overdue", "today", "later", "none"];
  const by = (g: DueGroup) => open.filter((t) => dueGroup(t) === g);

  return (
    <>
      {open.length === 0 && (
        <p role="status" className="rounded-md bg-green-100 px-4 py-3 text-green-950">
          今やることはありません。
        </p>
      )}
      {groups.map((g) => {
        const tasks = by(g);
        if (tasks.length === 0) return null;
        return (
          <section key={g} aria-labelledby={`todo-${g}`} className="flex flex-col gap-2">
            <h2 id={`todo-${g}`} className={`font-bold ${g === "overdue" ? "text-red-800" : ""}`}>
              {dueGroupLabel[g]}（{tasks.length}）
            </h2>
            <ul className="flex flex-col gap-2">
              {tasks.map((t) => (
                <TaskItem key={t.id} task={t} />
              ))}
            </ul>
          </section>
        );
      })}

      <Card title="やることを足す">
        <div className="p-5">
          <AddTaskForm roles={roles} />
        </div>
      </Card>

      {finished.length > 0 && (
        <details>
          <summary className="cursor-pointer font-bold">ここ7日に終わったもの（{finished.length}）</summary>
          <ul className="mt-2 flex flex-col">
            {finished.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 py-2 text-sm">
                {t.status === "done" ? <Tag tone="green">完了</Tag> : <Tag>取り消し</Tag>}
                <span>{t.title}</span>
                <span className="text-xs text-stone-500">
                  {t.completedAt ? `${ymdHm(t.completedAt)}・${t.completedBy ?? ""}` : ""}
                  {t.delayReason && `・遅れた理由：${t.delayReason}`}
                  {t.cancelReason && `・${t.cancelReason}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function TaskItem({ task: t }: { task: TaskRow }) {
  const step = t.order ? orderNextStep(t.order) : null;
  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border bg-white px-4 py-3 ${
        t.overdue ? "border-2 border-red-600" : "border-stone-300"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {t.status === "in_progress" && <Tag tone="blue">進行中</Tag>}
        {t.order ? (
          <Link href={`/fbm/${t.order.id}`} className="font-bold text-blue-800 hover:underline">
            {t.title}
          </Link>
        ) : (
          <span className="font-bold">{t.title}</span>
        )}
        <span className="ml-auto text-xs text-stone-600">
          {t.roleName}
          {t.assignee ? `（${t.assignee}）` : ""}
          {t.dueAt && (
            <span className={t.overdue ? "ml-2 font-bold text-red-800" : "ml-2"}>
              期限 {ymd(new Date(t.dueAt.getTime() - 1000))}
            </span>
          )}
        </span>
      </div>
      {step && (
        <p className={`text-sm ${step.warn ? "font-bold text-amber-900" : "text-stone-700"}`}>
          次にやること：{step.text}
        </p>
      )}
      {!t.order && t.description && <p className="text-sm text-stone-700">{t.description}</p>}
      {t.sourceKind === "manual" ? (
        <FinishTaskForm taskId={t.id} overdue={t.overdue} />
      ) : (
        <p className="text-xs text-stone-500">もとの作業が終わると、自動で完了します。</p>
      )}
    </li>
  );
}
