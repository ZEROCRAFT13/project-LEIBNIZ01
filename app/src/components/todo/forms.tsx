"use client";

import { useActionState, useState } from "react";
import { addTaskAction, finishTaskAction, type TodoState } from "@/app/todo/actions";

const inputClass = "h-11 rounded-md border border-stone-400 bg-white px-3";

function Message({ state }: { state: TodoState }) {
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

export function AddTaskForm({ roles }: { roles: { code: string; name: string }[] }) {
  const [state, action, pending] = useActionState<TodoState, FormData>(addTaskAction, null);
  const [seen, setSeen] = useState<number | null>(null);
  const [v, setV] = useState({ title: "", roleCode: roles.find((r) => r.code === "factory_manager")?.code ?? roles[0]?.code ?? "", due: "" });
  // 足せたら、やることの欄だけ空にする
  if (state?.ok && state.at !== seen) {
    setSeen(state.at);
    setV((x) => ({ ...x, title: "", due: "" }));
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium">
          やること
          <input
            name="title"
            value={v.title}
            onChange={(e) => setV((x) => ({ ...x, title: e.target.value }))}
            maxLength={200}
            placeholder="例：梱包材を発注する"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          担当
          <select name="roleCode" value={v.roleCode} onChange={(e) => setV((x) => ({ ...x, roleCode: e.target.value }))} className={inputClass}>
            {roles.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          期限
          <input type="date" name="due" value={v.due} onChange={(e) => setV((x) => ({ ...x, due: e.target.value }))} className={inputClass} />
        </label>
        <button type="submit" disabled={pending} className="h-11 rounded-md bg-blue-800 px-4 font-bold text-white disabled:opacity-60">
          足す
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

/** 手で足したタスクを完了・取り消しにする */
export function FinishTaskForm({ taskId, overdue }: { taskId: number; overdue: boolean }) {
  const [state, action, pending] = useActionState<TodoState, FormData>(finishTaskAction, null);
  const [reason, setReason] = useState("");
  const [cancel, setCancel] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <input type="hidden" name="how" value="done" />
        {overdue && (
          <input
            name="delayReason"
            aria-label="遅れた理由"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder="遅れた理由"
            className="h-9 w-56 rounded-md border border-stone-400 bg-white px-2 text-sm"
          />
        )}
        <button type="submit" disabled={pending} className="h-9 rounded-md bg-green-700 px-3 text-sm font-bold text-white">
          完了
        </button>
      </form>
      <details className="text-xs">
        <summary className="cursor-pointer text-stone-600">取り消す</summary>
        <form action={action} className="mt-1 flex flex-wrap items-center gap-2">
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="how" value="cancel" />
          <input
            name="cancelReason"
            aria-label="取り消しの理由"
            value={cancel}
            onChange={(e) => setCancel(e.target.value)}
            maxLength={200}
            placeholder="取り消しの理由"
            className="h-9 w-56 rounded-md border border-stone-400 bg-white px-2 text-sm"
          />
          <button type="submit" disabled={pending} className="h-9 rounded-md border border-red-700 px-3 text-sm text-red-800">
            取り消す
          </button>
        </form>
      </details>
      <Message state={state} />
    </div>
  );
}
