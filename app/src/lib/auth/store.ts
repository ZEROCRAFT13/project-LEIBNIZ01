import "server-only";
import type { PoolClient } from "pg";
import { query, withActor } from "@/lib/db";
import {
  ENROLL_CODE_MINUTES,
  formatEnrollCode,
  hashPin,
  newEnrollCode,
  newToken,
  normalizeEnrollCode,
  normalizePin,
  pinProblem,
  tokenHash,
  verifyPin,
} from "./crypto";

// ログインの記録を読み書きする処理。Cookie は扱わない（session.ts が受け持つ）ので、そのままテストできる。

export const USER_SESSION_HOURS = 24 * 7; // Google でログイン: 7日
export const WORKER_SESSION_HOURS = 12; // 組立端末でPIN: 12時間（1日の作業で終わる）
export const PIN_MAX_FAILS = 5; // 5回続けて間違えるとロック
const ENROLL_FAILS_PER_10MIN = 20; // 登録コードの総当たりを止める

/** 組立をしてよい役割 */
export const ASSEMBLY_ROLES = ["assembler", "factory_manager"];
/** 組立端末とバイトのPINを管理できる役割 */
export const MANAGER_ROLES = ["ceo", "factory_manager"];

export type Viewer = {
  sessionId: number;
  /** user = Google でログイン、worker = 組立端末でPIN */
  kind: "user" | "worker";
  user: { id: number; name: string; kind: "owner" | "staff" | "part_time" };
  roles: string[];
  device: { id: number; name: string } | null;
};

export type Issued = { token: string; expiresAt: Date };

type LoginEvent =
  | "google_login"
  | "google_denied"
  | "pin_login"
  | "pin_failed"
  | "pin_locked"
  | "logout"
  | "device_enrolled"
  | "device_enroll_failed"
  | "dev_login";

async function logEvent(
  client: PoolClient,
  event: LoginEvent,
  userId: number | null,
  deviceId: number | null = null,
  detail: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO auth.login_events (event, user_id, device_id, detail) VALUES ($1, $2, $3, $4)`,
    [event, userId, deviceId, detail],
  );
}

async function createSession(
  client: PoolClient,
  kind: "user" | "worker",
  userId: number,
  deviceId: number | null,
): Promise<Issued> {
  const token = newToken();
  const hours = kind === "user" ? USER_SESSION_HOURS : WORKER_SESSION_HOURS;
  const r = await client.query<{ expires_at: Date }>(
    `INSERT INTO auth.sessions (token_hash, kind, user_id, device_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
     RETURNING expires_at`,
    [tokenHash(token), kind, userId, deviceId, hours],
  );
  return { token, expiresAt: r.rows[0].expires_at };
}

const ACTIVE_ROLES = `ARRAY(SELECT DISTINCT ra.role_code FROM core.role_assignments ra
                            WHERE ra.user_id = u.id AND ra.valid_from <= now()
                              AND (ra.valid_to IS NULL OR ra.valid_to > now())
                            ORDER BY 1)`;

// ---------------------------------------------------------------------
// 今ログインしている人
// ---------------------------------------------------------------------

/**
 * Cookie の鍵から、ログインしている人を調べる。
 * 組立担当のセッションは、登録した端末の鍵が同じブラウザにあり、端末が無効になっていないときだけ有効。
 */
export async function findViewer(
  sessionToken: string | undefined,
  deviceToken: string | undefined,
): Promise<Viewer | null> {
  if (!sessionToken) return null;
  const rows = await query<{
    session_id: number;
    kind: "user" | "worker";
    user_id: number;
    name: string;
    user_kind: Viewer["user"]["kind"];
    roles: string[];
    device_id: number | null;
    device_name: string | null;
  }>(
    `SELECT s.id AS session_id, s.kind, u.id AS user_id, u.display_name AS name, u.kind AS user_kind,
            ${ACTIVE_ROLES} AS roles, d.id AS device_id, d.name AS device_name
       FROM auth.sessions s
       JOIN core.users u ON u.id = s.user_id AND u.active
       LEFT JOIN auth.devices d ON d.id = s.device_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND (s.kind = 'user'
             OR (d.revoked_at IS NULL AND d.token_hash IS NOT NULL AND d.token_hash = $2))`,
    [tokenHash(sessionToken), deviceToken ? tokenHash(deviceToken) : null],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    sessionId: r.session_id,
    kind: r.kind,
    user: { id: r.user_id, name: r.name, kind: r.user_kind },
    roles: r.roles,
    device: r.device_id ? { id: r.device_id, name: r.device_name ?? "" } : null,
  };
}

export async function logout(viewer: Viewer): Promise<void> {
  await withActor({ kind: "user", userId: viewer.user.id }, async (client) => {
    await client.query(`UPDATE auth.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
      viewer.sessionId,
    ]);
    await logEvent(client, "logout", viewer.user.id, viewer.device?.id ?? null);
  });
}

// ---------------------------------------------------------------------
// Google でログイン（代表・社員）
// ---------------------------------------------------------------------

/**
 * Google で本人確認が済んだメールアドレスで、セッションを作る。
 * 登録済みで有効な代表・社員だけ。バイトは組立端末のPINを使う。
 */
export async function loginWithGoogle(email: string): Promise<Issued | null> {
  return withActor({ kind: "system" }, async (client) => {
    const r = await client.query<{ id: number }>(
      `SELECT id FROM core.users WHERE email = lower($1) AND active AND kind IN ('owner', 'staff')`,
      [email],
    );
    const userId = r.rows[0]?.id;
    if (!userId) {
      await logEvent(client, "google_denied", null, null, `登録されていないアカウント: ${email}`.slice(0, 200));
      return null;
    }
    const issued = await createSession(client, "user", userId, null);
    await logEvent(client, "google_login", userId);
    return issued;
  });
}

/** 開発中だけ使うログイン（Google の設定なしで画面を確かめる）。呼ぶ側で開発環境かを確かめる */
export async function devLogin(userId: number): Promise<Issued | null> {
  return withActor({ kind: "system" }, async (client) => {
    const r = await client.query(`SELECT 1 FROM core.users WHERE id = $1 AND active AND kind IN ('owner', 'staff')`, [
      userId,
    ]);
    if (r.rowCount !== 1) return null;
    const issued = await createSession(client, "user", userId, null);
    await logEvent(client, "dev_login", userId);
    return issued;
  });
}

export type DevLoginUser = { id: number; name: string };

export async function listDevLoginUsers(): Promise<DevLoginUser[]> {
  return query<DevLoginUser>(
    `SELECT id, display_name AS name FROM core.users WHERE active AND kind IN ('owner', 'staff') ORDER BY id`,
  );
}

// ---------------------------------------------------------------------
// 組立用の端末
// ---------------------------------------------------------------------

export type Device = { id: number; name: string };

/** ブラウザに保存された端末の鍵から、登録済みの端末を探す */
export async function findDevice(deviceToken: string | undefined): Promise<Device | null> {
  if (!deviceToken) return null;
  const rows = await query<Device>(
    `SELECT id, name FROM auth.devices WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash(deviceToken)],
  );
  return rows[0] ?? null;
}

export type Enrollment = { deviceId: number; name: string; code: string; expiresAt: Date };

/** 端末を作り、登録コードを出す（コードはこのとき1回だけ表示できる。DBにはハッシュだけ） */
export async function createEnrollment(actorId: number, rawName: string): Promise<Enrollment> {
  const name = rawName.trim(); // 名前は全角の（）などをそのまま残す
  if (name.length < 1 || name.length > 40) throw new EnrollError("端末の名前は1〜40文字で付けてください。");
  const code = newEnrollCode();
  return withActor({ kind: "user", userId: actorId }, async (client) => {
    const r = await client.query<{ id: number; enroll_expires_at: Date }>(
      `INSERT INTO auth.devices (name, enroll_code_hash, enroll_expires_at, registered_by)
       VALUES ($1, $2, now() + make_interval(mins => $3), $4)
       RETURNING id, enroll_expires_at`,
      [name, tokenHash(code), ENROLL_CODE_MINUTES, actorId],
    );
    return { deviceId: r.rows[0].id, name, code: formatEnrollCode(code), expiresAt: r.rows[0].enroll_expires_at };
  });
}

/** まだ登録していない端末の登録コードを出し直す */
export async function reissueEnrollment(actorId: number, deviceId: number): Promise<Enrollment> {
  const code = newEnrollCode();
  return withActor({ kind: "user", userId: actorId }, async (client) => {
    const r = await client.query<{ name: string; enroll_expires_at: Date }>(
      `UPDATE auth.devices
          SET enroll_code_hash = $2, enroll_expires_at = now() + make_interval(mins => $3)
        WHERE id = $1 AND enrolled_at IS NULL AND revoked_at IS NULL
        RETURNING name, enroll_expires_at`,
      [deviceId, tokenHash(code), ENROLL_CODE_MINUTES],
    );
    if (r.rowCount !== 1) throw new EnrollError("この端末はもう登録済みか、無効になっています。");
    return { deviceId, name: r.rows[0].name, code: formatEnrollCode(code), expiresAt: r.rows[0].enroll_expires_at };
  });
}

export class EnrollError extends Error {}

/** 端末で登録コードを入れる。合っていれば、その端末に保存する鍵を返す */
export async function enrollDevice(rawCode: string): Promise<{ ok: true; token: string; device: Device } | { ok: false; message: string }> {
  const code = normalizeEnrollCode(rawCode);
  return withActor({ kind: "system" }, async (client) => {
    const recent = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth.login_events
        WHERE event = 'device_enroll_failed' AND at > now() - interval '10 minutes'`,
    );
    if (recent.rows[0].n >= ENROLL_FAILS_PER_10MIN) {
      return { ok: false as const, message: "間違いが続いたので、10分ほど待ってからやり直してください。" };
    }
    const token = newToken();
    const r = code
      ? await client.query<Device>(
          `UPDATE auth.devices
              SET token_hash = $2, enrolled_at = now(), enroll_code_hash = NULL, enroll_expires_at = NULL
            WHERE enroll_code_hash = $1 AND enroll_expires_at > now() AND revoked_at IS NULL
            RETURNING id, name`,
          [tokenHash(code), tokenHash(token)],
        )
      : { rows: [] as Device[] };
    const device = r.rows[0];
    if (!device) {
      await logEvent(client, "device_enroll_failed", null);
      return { ok: false as const, message: "登録コードが違うか、期限（10分）が切れています。代表に出し直してもらってください。" };
    }
    await logEvent(client, "device_enrolled", null, device.id);
    return { ok: true as const, token, device };
  });
}

export type DeviceRow = {
  id: number;
  name: string;
  registeredBy: string;
  createdAt: Date;
  enrolledAt: Date | null;
  /** 登録コードがまだ使える */
  codeValid: boolean;
  lastLoginAt: Date | null;
  revokedAt: Date | null;
};

export async function listDevices(): Promise<DeviceRow[]> {
  return query<DeviceRow>(
    `SELECT d.id, d.name, u.display_name AS "registeredBy", d.created_at AS "createdAt",
            d.enrolled_at AS "enrolledAt", coalesce(d.enroll_expires_at > now(), false) AS "codeValid",
            d.last_login_at AS "lastLoginAt", d.revoked_at AS "revokedAt"
       FROM auth.devices d JOIN core.users u ON u.id = d.registered_by
      ORDER BY d.revoked_at IS NOT NULL, d.id DESC`,
  );
}

/** 端末を無効にする（なくした・使わなくなった）。その端末でのログインもすべて切る */
export async function revokeDevice(actorId: number, deviceId: number): Promise<void> {
  await withActor({ kind: "user", userId: actorId }, async (client) => {
    await client.query(
      `UPDATE auth.devices SET revoked_at = now(), revoked_by = $2, enroll_code_hash = NULL, enroll_expires_at = NULL
        WHERE id = $1 AND revoked_at IS NULL`,
      [deviceId, actorId],
    );
    await client.query(`UPDATE auth.sessions SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, [
      deviceId,
    ]);
  });
}

// ---------------------------------------------------------------------
// 組立担当のPIN
// ---------------------------------------------------------------------

export type PinWorker = { id: number; name: string; locked: boolean };

/** 組立端末に出す名前（組立の役割があり、PINが設定されている人） */
export async function listPinWorkers(): Promise<PinWorker[]> {
  return query<PinWorker>(
    `SELECT u.id, u.display_name AS name, p.locked_at IS NOT NULL AS locked
       FROM core.users u
       JOIN auth.worker_pins p ON p.user_id = u.id
      WHERE u.active
        AND EXISTS (SELECT 1 FROM core.role_assignments ra
                     WHERE ra.user_id = u.id AND ra.role_code = ANY($1)
                       AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now()))
      ORDER BY u.kind = 'part_time' DESC, u.id`,
    [ASSEMBLY_ROLES],
  );
}

export type PinResult = { ok: true; issued: Issued } | { ok: false; message: string };

/** 組立端末でPINを入れる。端末の鍵がない・無効ならログインさせない */
export async function pinLogin(deviceToken: string | undefined, userId: number, rawPin: string): Promise<PinResult> {
  const device = await findDevice(deviceToken);
  if (!device) return { ok: false, message: "この端末は組立用に登録されていません。代表に登録してもらってください。" };
  const pin = normalizePin(rawPin);

  return withActor({ kind: "system" }, async (client) => {
    const r = await client.query<{ pin_hash: string; failed_count: number; locked: boolean }>(
      `SELECT p.pin_hash, p.failed_count, p.locked_at IS NOT NULL AS locked
         FROM auth.worker_pins p
         JOIN core.users u ON u.id = p.user_id AND u.active
        WHERE p.user_id = $1
          AND EXISTS (SELECT 1 FROM core.role_assignments ra
                       WHERE ra.user_id = u.id AND ra.role_code = ANY($2)
                         AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now()))
        FOR UPDATE OF p`,
      [userId, ASSEMBLY_ROLES],
    );
    const row = r.rows[0];
    if (!row) return { ok: false as const, message: "この人は組立端末でログインできません。" };
    if (row.locked) {
      return { ok: false as const, message: "PINを続けて間違えたのでロックされています。代表に解除してもらってください。" };
    }

    if (!(await verifyPin(pin, row.pin_hash))) {
      const fails = row.failed_count + 1;
      const lock = fails >= PIN_MAX_FAILS;
      await client.query(
        `UPDATE auth.worker_pins SET failed_count = $2, locked_at = CASE WHEN $3 THEN now() END WHERE user_id = $1`,
        [userId, fails, lock],
      );
      await logEvent(client, lock ? "pin_locked" : "pin_failed", userId, device.id);
      return {
        ok: false as const,
        message: lock
          ? "PINを続けて間違えたのでロックしました。代表に解除してもらってください。"
          : `PINが違います（あと${PIN_MAX_FAILS - fails}回間違えるとロックされます）。`,
      };
    }

    if (row.failed_count > 0) {
      await client.query(`UPDATE auth.worker_pins SET failed_count = 0 WHERE user_id = $1`, [userId]);
    }
    await client.query(`UPDATE auth.devices SET last_login_at = now() WHERE id = $1`, [device.id]);
    const issued = await createSession(client, "worker", userId, device.id);
    await logEvent(client, "pin_login", userId, device.id);
    return { ok: true as const, issued };
  });
}

export type WorkerAccount = {
  id: number;
  name: string;
  kind: "owner" | "staff" | "part_time";
  hasPin: boolean;
  locked: boolean;
  failedCount: number;
};

/** 組立の役割を持つ人と、PINの状態 */
export async function listWorkerAccounts(): Promise<WorkerAccount[]> {
  return query<WorkerAccount>(
    `SELECT u.id, u.display_name AS name, u.kind, p.user_id IS NOT NULL AS "hasPin",
            p.locked_at IS NOT NULL AS locked, coalesce(p.failed_count, 0) AS "failedCount"
       FROM core.users u
       LEFT JOIN auth.worker_pins p ON p.user_id = u.id
      WHERE u.active
        AND EXISTS (SELECT 1 FROM core.role_assignments ra
                     WHERE ra.user_id = u.id AND ra.role_code = ANY($1)
                       AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now()))
      ORDER BY u.kind = 'part_time' DESC, u.id`,
    [ASSEMBLY_ROLES],
  );
}

export class AccountError extends Error {}

/** PINを設定する（新しく決める・忘れたときに決め直す）。ロックも解除する */
export async function setWorkerPin(actorId: number, userId: number, rawPin: string): Promise<void> {
  const pin = normalizePin(rawPin);
  const problem = pinProblem(pin);
  if (problem) throw new AccountError(problem);
  const pinHash = await hashPin(pin);
  await withActor({ kind: "user", userId: actorId }, async (client) => {
    const ok = await client.query(
      `SELECT 1 FROM core.users u
        WHERE u.id = $1 AND u.active
          AND EXISTS (SELECT 1 FROM core.role_assignments ra
                       WHERE ra.user_id = u.id AND ra.role_code = ANY($2)
                         AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now()))`,
      [userId, ASSEMBLY_ROLES],
    );
    if (ok.rowCount !== 1) throw new AccountError("この人には組立の役割がありません。");
    await client.query(
      `INSERT INTO auth.worker_pins (user_id, pin_hash, set_by) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET pin_hash = EXCLUDED.pin_hash, set_by = EXCLUDED.set_by,
             failed_count = 0, locked_at = NULL, updated_at = now()`,
      [userId, pinHash, actorId],
    );
  });
}

/** ロックを解除する（PINはそのまま） */
export async function unlockWorkerPin(actorId: number, userId: number): Promise<void> {
  await withActor({ kind: "user", userId: actorId }, async (client) => {
    await client.query(
      `UPDATE auth.worker_pins SET failed_count = 0, locked_at = NULL, updated_at = now()
        WHERE user_id = $1 AND (locked_at IS NOT NULL OR failed_count > 0)`,
      [userId],
    );
  });
}

/** バイトを追加する（名前だけ。メールアドレスは作らない）。組立担当の役割を付ける */
export async function addPartTimer(actorId: number, rawName: string): Promise<number> {
  const name = rawName.trim(); // 名前は全角の（）などをそのまま残す
  if (name.length < 1 || name.length > 30) throw new AccountError("名前は1〜30文字で入れてください。");
  return withActor({ kind: "user", userId: actorId }, async (client) => {
    const r = await client.query<{ id: number }>(
      `INSERT INTO core.users (display_name, kind) VALUES ($1, 'part_time') RETURNING id`,
      [name],
    );
    const id = r.rows[0].id;
    await client.query(`INSERT INTO core.role_assignments (role_code, user_id) VALUES ('assembler', $1)`, [id]);
    return id;
  });
}

/** バイトの利用を止める（辞めたとき）。ログイン中なら切る。記録は残る */
export async function deactivatePartTimer(actorId: number, userId: number): Promise<void> {
  await withActor({ kind: "user", userId: actorId }, async (client) => {
    const r = await client.query(
      `UPDATE core.users SET active = false WHERE id = $1 AND kind = 'part_time' AND active`,
      [userId],
    );
    if (r.rowCount !== 1) throw new AccountError("この人は止められません（バイトだけ止められます）。");
    await client.query(
      `UPDATE core.role_assignments SET valid_to = now()
        WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now()) AND valid_from < now()`,
      [userId],
    );
    await client.query(`UPDATE auth.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
      userId,
    ]);
  });
}
