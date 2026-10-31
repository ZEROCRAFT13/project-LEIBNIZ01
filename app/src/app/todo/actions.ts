"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { parseManualTask } from "@/lib/task-calc";
import { addManualTask, finishManualTask } from "@/lib/tasks";

// ToDo の操作。Google でログインした人だけ。担当にできるのは、自分が持っている役割だけ。

export type TodoState = { ok: boolean; message: string; at: number } | null;

export async function addTaskAction(_prev: TodoState, formData: FormData): Promise<TodoState> {
  const viewer = await requireUser("/todo");
  const parsed = parseManualTask(Object.fromEntries(formData), viewer.roles);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" "), at: Date.now() };
  const r = await addManualTask(viewer.user.id, parsed.value);
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}

export async function finishTaskAction(_prev: TodoState, formData: FormData): Promise<TodoState> {
  const viewer = await requireUser("/todo");
  const id = Number(formData.get("taskId"));
  const done = formData.get("how") === "done";
  const r = await finishManualTask(
    viewer.user.id,
    id,
    done
      ? { done: true, delayReason: String(formData.get("delayReason") ?? "") || null }
      : { done: false, cancelReason: String(formData.get("cancelReason") ?? "") },
  );
  if (r.ok) refresh();
  return { ...r, at: Date.now() };
}
