// ログインの記録のテスト。db/seeds のダミーデータ（佐藤 PIN 1357・高橋 PIN 2468）が入ったDBに対して動かす
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, query } from "@/lib/db";
import {
  AccountError,
  PIN_MAX_FAILS,
  addPartTimer,
  createEnrollment,
  deactivatePartTimer,
  enrollDevice,
  findDevice,
  findViewer,
  listDevices,
  listPinWorkers,
  listWorkerAccounts,
  loginWithGoogle,
  logout,
  pinLogin,
  reissueEnrollment,
  revokeDevice,
  setWorkerPin,
  unlockWorkerPin,
} from "./store";

let owner: number;
let sato: number;
let takahashi: number;
let deviceToken: string;

async function userId(email: string): Promise<number> {
  const [u] = await query<{ id: number }>("SELECT id FROM core.users WHERE email = $1", [email]);
  return u.id;
}

async function lastEvent(): Promise<{ event: string; user_id: number | null }> {
  const [e] = await query<{ event: string; user_id: number | null }>(
    "SELECT event, user_id FROM auth.login_events ORDER BY id DESC LIMIT 1",
  );
  return e;
}

beforeAll(async () => {
  owner = await userId("owner@zerobit.example");
  sato = await userId("sato@zerobit.example");
  takahashi = await userId("takahashi@zerobit.example");
});

afterAll(async () => {
  await getPool().end();
});

describe("組立用の端末を登録する", () => {
  it("代表が登録コードを出し、端末でコードを入れると鍵がもらえる。コードは1回だけ使える", async () => {
    const e = await createEnrollment(owner, " 組立台1のスマホ ");
    expect(e.name).toBe("組立台1のスマホ");
    expect(e.code).toMatch(/^\d{4}-\d{4}$/);
    expect((await listDevices()).find((d) => d.id === e.deviceId)).toMatchObject({ codeValid: true, enrolledAt: null });

    const wrong = await enrollDevice(e.code === "0000-0000" ? "0000-0001" : "0000-0000");
    expect(wrong).toMatchObject({ ok: false });
    expect(await lastEvent()).toMatchObject({ event: "device_enroll_failed" });

    const r = await enrollDevice(e.code.replace("-", " "));
    if (!r.ok) throw new Error(r.message);
    deviceToken = r.token;
    expect(r.device).toEqual({ id: e.deviceId, name: "組立台1のスマホ" });
    expect(await findDevice(deviceToken)).toEqual(r.device);
    expect(await enrollDevice(e.code)).toMatchObject({ ok: false });
    expect((await listDevices()).find((d) => d.id === e.deviceId)).toMatchObject({ codeValid: false });
  });

  it("登録済みの端末は、コードを出し直せない", async () => {
    const [d] = await query<{ id: number }>("SELECT id FROM auth.devices WHERE enrolled_at IS NOT NULL LIMIT 1");
    await expect(reissueEnrollment(owner, d.id)).rejects.toThrow("登録済み");
  });

  it("名前が空なら作らない", async () => {
    await expect(createEnrollment(owner, "  ")).rejects.toThrow("1〜40文字");
  });

  it("知らない鍵は端末として扱わない", async () => {
    expect(await findDevice("not-a-token")).toBeNull();
    expect(await findDevice(undefined)).toBeNull();
  });
});

describe("組立端末でPINを入れる", () => {
  it("PINが設定されている、組立の役割を持つ人の名前が出る", async () => {
    const names = (await listPinWorkers()).map((w) => w.name);
    expect(names).toEqual(["佐藤（バイト）", "高橋（バイト）"]);
  });

  it("登録していない端末では、PINが合っていてもログインできない", async () => {
    expect(await pinLogin(undefined, sato, "1357")).toMatchObject({ ok: false });
    expect(await pinLogin("unknown-device", sato, "1357")).toMatchObject({ ok: false });
  });

  it("PINが合えばログインできる。セッションはその端末の鍵とセットでだけ有効", async () => {
    const r = await pinLogin(deviceToken, sato, "１３５７");
    if (!r.ok) throw new Error(r.message);
    const viewer = await findViewer(r.issued.token, deviceToken);
    expect(viewer).toMatchObject({
      kind: "worker",
      user: { id: sato, name: "佐藤（バイト）", kind: "part_time" },
      roles: ["assembler"],
      device: { name: "組立台1のスマホ" },
    });
    // 12時間で切れる
    const hours = (r.issued.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
    // 鍵を別のブラウザに持ち出しても使えない
    expect(await findViewer(r.issued.token, undefined)).toBeNull();
    expect(await findViewer(r.issued.token, "other-device")).toBeNull();
    expect(await lastEvent()).toMatchObject({ event: "pin_login", user_id: sato });
  });

  it(`${PIN_MAX_FAILS}回続けて間違えるとロックされ、合っていても入れない。代表が解除すると入れる`, async () => {
    for (let i = 1; i < PIN_MAX_FAILS; i++) {
      const r = await pinLogin(deviceToken, takahashi, "0000");
      expect(r).toEqual({ ok: false, message: `PINが違います（あと${PIN_MAX_FAILS - i}回間違えるとロックされます）。` });
    }
    expect(await pinLogin(deviceToken, takahashi, "0000")).toMatchObject({ ok: false, message: expect.stringContaining("ロックしました") });
    expect(await lastEvent()).toMatchObject({ event: "pin_locked", user_id: takahashi });
    expect(await pinLogin(deviceToken, takahashi, "2468")).toMatchObject({ ok: false, message: expect.stringContaining("ロックされています") });
    expect((await listPinWorkers()).find((w) => w.id === takahashi)?.locked).toBe(true);

    await unlockWorkerPin(owner, takahashi);
    expect(await pinLogin(deviceToken, takahashi, "2468")).toMatchObject({ ok: true });
  });

  it("間違えた回数は、正しく入れると0に戻る", async () => {
    await pinLogin(deviceToken, sato, "0000");
    expect((await listWorkerAccounts()).find((a) => a.id === sato)?.failedCount).toBe(1);
    await pinLogin(deviceToken, sato, "1357");
    expect((await listWorkerAccounts()).find((a) => a.id === sato)?.failedCount).toBe(0);
  });

  it("組立の役割がない人（代表がPIN未設定）はPINで入れない", async () => {
    expect(await pinLogin(deviceToken, owner, "1357")).toMatchObject({ ok: false });
  });
});

describe("バイトの追加とPIN", () => {
  let suzuki: number;

  it("名前だけで追加でき、メールアドレスは作らない", async () => {
    suzuki = await addPartTimer(owner, "鈴木（バイト）");
    const [u] = await query<{ email: string | null; kind: string }>("SELECT email, kind FROM core.users WHERE id = $1", [suzuki]);
    expect(u).toEqual({ email: null, kind: "part_time" });
    expect((await listWorkerAccounts()).find((a) => a.id === suzuki)).toMatchObject({ hasPin: false, locked: false });
    // PINを決めるまでは組立端末に名前が出ない
    expect((await listPinWorkers()).some((w) => w.id === suzuki)).toBe(false);
  });

  it("分かりやすいPINは断り、決めたPINで入れる", async () => {
    await expect(setWorkerPin(owner, suzuki, "1234")).rejects.toThrow(AccountError);
    await expect(setWorkerPin(owner, suzuki, "7777")).rejects.toThrow(AccountError);
    await setWorkerPin(owner, suzuki, "4071");
    expect(await pinLogin(deviceToken, suzuki, "4071")).toMatchObject({ ok: true });
  });

  it("組立の役割がない人にはPINを決められない", async () => {
    const [staff] = await query<{ id: number }>(
      "SELECT id FROM core.users WHERE NOT EXISTS (SELECT 1 FROM core.role_assignments ra WHERE ra.user_id = users.id) LIMIT 1",
    );
    if (staff) await expect(setWorkerPin(owner, staff.id, "4071")).rejects.toThrow(AccountError);
    await expect(setWorkerPin(owner, 999999, "4071")).rejects.toThrow(AccountError);
  });

  it("利用を止めると、ログイン中でも切れて、もう入れない。代表は止められない", async () => {
    const r = await pinLogin(deviceToken, suzuki, "4071");
    if (!r.ok) throw new Error(r.message);
    await deactivatePartTimer(owner, suzuki);
    expect(await findViewer(r.issued.token, deviceToken)).toBeNull();
    expect(await pinLogin(deviceToken, suzuki, "4071")).toMatchObject({ ok: false });
    expect((await listWorkerAccounts()).some((a) => a.id === suzuki)).toBe(false);
    await expect(deactivatePartTimer(owner, owner)).rejects.toThrow(AccountError);
  });
});

describe("Google でログイン", () => {
  it("登録済みの代表は入れる（大文字でも）。7日で切れる。PINの端末の鍵は要らない", async () => {
    const issued = await loginWithGoogle("Owner@zerobit.example");
    if (!issued) throw new Error("ログインできませんでした");
    const viewer = await findViewer(issued.token, undefined);
    expect(viewer).toMatchObject({ kind: "user", user: { id: owner, kind: "owner" }, device: null });
    expect(viewer?.roles).toContain("ceo");
    expect(viewer?.roles).not.toContain("assembler");
    const days = (issued.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(await lastEvent()).toMatchObject({ event: "google_login", user_id: owner });

    // ログアウトすると、その鍵はもう使えない
    if (!viewer) throw new Error("viewer");
    await logout(viewer);
    expect(await findViewer(issued.token, undefined)).toBeNull();
    expect(await lastEvent()).toMatchObject({ event: "logout", user_id: owner });
  });

  it("登録されていないアカウントとバイトは入れない（記録は残る）", async () => {
    expect(await loginWithGoogle("stranger@zerobit.example")).toBeNull();
    expect(await lastEvent()).toMatchObject({ event: "google_denied", user_id: null });
    expect(await loginWithGoogle("sato@zerobit.example")).toBeNull();
  });
});

describe("端末を無効にする", () => {
  it("無効にすると、その端末のログインはすべて切れ、PINでも入れない", async () => {
    const r = await pinLogin(deviceToken, sato, "1357");
    if (!r.ok) throw new Error(r.message);
    const device = await findDevice(deviceToken);
    if (!device) throw new Error("device");
    await revokeDevice(owner, device.id);
    expect(await findViewer(r.issued.token, deviceToken)).toBeNull();
    expect(await findDevice(deviceToken)).toBeNull();
    expect(await pinLogin(deviceToken, sato, "1357")).toMatchObject({ ok: false });
  });
});
