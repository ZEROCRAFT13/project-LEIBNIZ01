-- =====================================================================
-- ログイン
--   代表・社員 : Google Workspace のアカウントでログインする（2段階認証は Workspace 側で必須にする）
--   組立担当   : 代表が登録した組立用の端末で、名前を選んで4桁のPINを入れる
--                （「登録済みの端末を持っている」＋「PINを知っている」の2つがそろって入れる）
-- トークンやPINはハッシュだけを保存する。監査ログにもハッシュの値を残さない（列名だけ）。
-- =====================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;

-- ---------------------------------------------------------------------
-- バイトはメールアドレスなしで登録できるようにする（Googleアカウントを作らない）
-- 代表・社員は Google でログインするのでメールアドレスが必要。小文字にそろえる
-- ---------------------------------------------------------------------
ALTER TABLE core.users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE core.users
  ADD CONSTRAINT users_email_required CHECK (kind = 'part_time' OR email IS NOT NULL),
  ADD CONSTRAINT users_email_lower    CHECK (email = lower(email));

-- ---------------------------------------------------------------------
-- 組立用の端末
--   代表が名前を付けて作ると、10分だけ使える登録コードが出る。
--   端末でコードを入れると、その端末のブラウザに鍵（トークン）が保存される。
-- ---------------------------------------------------------------------
CREATE TABLE auth.devices (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  token_hash        bytea UNIQUE,              -- 登録が済むまで空
  enroll_code_hash  bytea UNIQUE,              -- 登録が済んだら空に戻す
  enroll_expires_at timestamptz,
  registered_by     bigint NOT NULL REFERENCES core.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  enrolled_at       timestamptz,
  last_login_at     timestamptz,               -- 最後にPINでログインがあった時刻
  revoked_at        timestamptz,
  revoked_by        bigint REFERENCES core.users(id),
  CHECK ((token_hash IS NULL) = (enrolled_at IS NULL)),
  CHECK (enroll_code_hash IS NULL OR enroll_expires_at IS NOT NULL),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- ---------------------------------------------------------------------
-- 組立担当のPIN（scrypt のハッシュ）。5回続けて間違えるとロックし、代表が解除する
-- ---------------------------------------------------------------------
CREATE TABLE auth.worker_pins (
  user_id      bigint PRIMARY KEY REFERENCES core.users(id),
  pin_hash     text NOT NULL CHECK (pin_hash LIKE 'scrypt$%'),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_at    timestamptz,
  set_by       bigint NOT NULL REFERENCES core.users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- ログイン中の状態（セッション）
--   user   : Google でログイン（7日）
--   worker : 組立端末でPIN（12時間）。必ず端末にひもづく
-- 消さずに revoked_at で無効にする
-- ---------------------------------------------------------------------
CREATE TABLE auth.sessions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash   bytea NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('user', 'worker')),
  user_id      bigint NOT NULL REFERENCES core.users(id),
  device_id    bigint REFERENCES auth.devices(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CHECK (kind = 'user' OR device_id IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX ON auth.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON auth.sessions (device_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- ログインの記録（追記のみ）。失敗も残す。メールアドレスは社内アカウントのものだけ
-- ---------------------------------------------------------------------
CREATE TABLE auth.login_events (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  event     text NOT NULL CHECK (event IN (
              'google_login', 'google_denied', 'pin_login', 'pin_failed', 'pin_locked',
              'logout', 'device_enrolled', 'device_enroll_failed', 'dev_login')),
  user_id   bigint REFERENCES core.users(id),
  device_id bigint REFERENCES auth.devices(id),
  detail    text CHECK (length(detail) <= 200)
);
CREATE INDEX ON auth.login_events (at);
CREATE TRIGGER login_events_append_only BEFORE UPDATE OR DELETE ON auth.login_events
  FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

-- ---------------------------------------------------------------------
-- 監査ログ: auth の表も pii と同じく、値を残さず列名だけ残す（ハッシュを残さない）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_kind    text   := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'system');
  v_user    bigint := nullif(current_setting('app.actor_user_id', true), '')::bigint;
  v_old     jsonb  := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new     jsonb  := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  v_cols    text[];
  v_hide    boolean := (TG_TABLE_SCHEMA IN ('pii', 'auth'));
  v_pk      text   := TG_ARGV[0];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_cols
      FROM jsonb_object_keys(v_new) AS k
     WHERE v_new -> k IS DISTINCT FROM v_old -> k;
    IF v_cols IS NULL THEN
      RETURN NEW;  -- 何も変わっていない
    END IF;
  ELSE
    SELECT array_agg(k ORDER BY k) INTO v_cols FROM jsonb_object_keys(coalesce(v_new, v_old)) AS k;
  END IF;

  INSERT INTO audit.log (actor_kind, actor_user_id, table_name, row_id, action, changed_columns, before, after)
  VALUES (v_kind, v_user, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
          coalesce(v_new, v_old) ->> v_pk, TG_OP, v_cols,
          CASE WHEN v_hide THEN NULL ELSE v_old END,
          CASE WHEN v_hide THEN NULL ELSE v_new END);
  RETURN coalesce(NEW, OLD);
END $$;

-- 端末の登録・無効化とPINの設定は、誰がやったかを監査ログに残す
-- （セッションはログインのたびに増えるので、login_events で追う）
CREATE TRIGGER audit_devices AFTER INSERT OR UPDATE OR DELETE ON auth.devices
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');
CREATE TRIGGER audit_worker_pins AFTER INSERT OR UPDATE OR DELETE ON auth.worker_pins
  FOR EACH ROW EXECUTE FUNCTION audit.record('user_id');

-- ---------------------------------------------------------------------
-- 権限: アプリ本体はログインの表を読み書きできるが、消せない。ログインの記録は追記だけ
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA auth TO zb_app;
GRANT SELECT, INSERT, UPDATE ON auth.devices, auth.worker_pins, auth.sessions TO zb_app;
GRANT SELECT, INSERT ON auth.login_events TO zb_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO zb_app;

GRANT USAGE ON SCHEMA auth TO zb_auditor;
GRANT SELECT ON auth.login_events TO zb_auditor;
GRANT SELECT (id, name, registered_by, created_at, enrolled_at, last_login_at, revoked_at, revoked_by)
  ON auth.devices TO zb_auditor;

COMMIT;
