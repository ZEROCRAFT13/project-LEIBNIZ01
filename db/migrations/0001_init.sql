-- =====================================================================
-- ZERO-BIT 基幹システム  データベース定義 v0.1（フェーズ0〜1）
-- 対象: PostgreSQL 16（Google Cloud SQL）
-- 仕様書「ZERO-BIT 基幹システム 要件定義書」9章をもとに作成
--
-- 構成
--   core  : 業務データ（個体・部品・仕入れ・注文・会話・タスクなど）
--           顧客は「顧客番号」だけを持ち、氏名などは持たない
--   pii   : 顧客の個人情報（暗号化して保存。アプリ側で暗号化・復号する）
--   audit : 監査ログ（追記のみ。更新・削除はできない）
--
-- 約束ごと
--   - 金額は円の整数（bigint）。
--   - 状態などの選択肢は text + CHECK で持つ（あとから選択肢を増やしやすい）。
--   - アプリは操作のたびにトランザクションの先頭で次を設定する:
--       SET LOCAL app.actor_kind = 'user' | 'system' | 'ai';
--       SET LOCAL app.actor_user_id = '<users.id>';   -- 人のときだけ
--     監査ログはこの値を使って「誰が」を記録する。
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS pii;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------------
-- 共通の関数
-- ---------------------------------------------------------------------

-- updated_at を自動で更新する
CREATE FUNCTION core.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- 追記専用の表で UPDATE / DELETE を止める
CREATE FUNCTION core.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% は追記専用です（% はできません）', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP;
END $$;

-- ---------------------------------------------------------------------
-- 設定値（損益分岐ACOS、FBAリードタイム、箱を保管する金額の基準など）
-- ---------------------------------------------------------------------
CREATE TABLE core.settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER settings_touch BEFORE UPDATE ON core.settings
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

INSERT INTO core.settings (key, value, description) VALUES
  ('fba_lead_time_days',     '5',      '組立開始からFBA受領までの日数'),
  ('sales_pace_window_days', '14',     '販売ペースを計算する期間（日）'),
  ('keep_box_min_cost',      '20000',  'この金額（税抜）以上の部品は元箱を保管する'),
  ('warranty_months_base',   '12',     '標準の保証期間（月）'),
  ('warranty_months_registered', '24', '製品登録後の保証期間（月）'),
  ('amazon_reply_hours',     '24',     'Amazonの問い合わせの返信期限（時間）');

-- ---------------------------------------------------------------------
-- 利用者と役割（役割と人を分けて持つ。仕様書4章）
-- ---------------------------------------------------------------------
CREATE TABLE core.users (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        text NOT NULL UNIQUE,             -- 社内のGoogleアカウント（顧客ではない）
  display_name text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('owner', 'staff', 'part_time')),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.roles (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text
);

INSERT INTO core.roles (code, name, description) VALUES
  ('ceo',             'CEO',                    '全体の確認と承認'),
  ('project_lead',    'プロジェクトリーダー',    '新SKU・改善プロジェクト・システム導入'),
  ('factory_manager', '工場長',                  '組立・検品・部品在庫・FBA納品・RMA・品質'),
  ('marketing_lead',  'マーケティングリーダー',  '広告・商品ページ・YouTube・撮影用資産'),
  ('admin_lead',      '管理リーダー',            '記帳・請求・支払い・決算・行政書類'),
  ('support',         'サポート担当',            '受信箱・修理受付・製品登録・保証'),
  ('assembler',       '組立担当',                '組立のみ（スマホ画面）');

-- いつからいつまで、誰がその役割を持っていたか
CREATE TABLE core.role_assignments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_code  text NOT NULL REFERENCES core.roles(code),
  user_id    bigint NOT NULL REFERENCES core.users(id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to   timestamptz,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX ON core.role_assignments (role_code, valid_from);

-- ---------------------------------------------------------------------
-- 部品マスタ・SKU・構成表
-- ---------------------------------------------------------------------
CREATE TABLE core.part_models (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category              text NOT NULL CHECK (category IN
                          ('cpu','gpu','motherboard','memory','ssd','psu','cooler','case','fan','os','other')),
  maker                 text NOT NULL,
  model_no              text NOT NULL,
  name                  text NOT NULL,
  jan_code              text,
  serial_required       boolean NOT NULL DEFAULT true,   -- 組立時にシリアルを読む必要があるか
  keep_box              boolean NOT NULL DEFAULT false,  -- 元箱を保管するか（RMA用）
  maker_warranty_months integer CHECK (maker_warranty_months >= 0),
  active                boolean NOT NULL DEFAULT true,
  UNIQUE (maker, model_no)
);
CREATE UNIQUE INDEX part_models_jan_uq ON core.part_models (jan_code) WHERE jan_code IS NOT NULL;

CREATE TABLE core.skus (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       text NOT NULL UNIQUE,                   -- 例: ZB-G5070-R7
  name       text NOT NULL,
  list_price bigint CHECK (list_price >= 0),         -- 税込
  active     boolean NOT NULL DEFAULT true
);

-- 構成表は「枠（slot）」と「その枠に使ってよい型番」の2段にする。
-- 例: ZB-G5070-R7 の GPU 枠には、メーカー違いの RTX 5070 を複数登録できる。
CREATE TABLE core.sku_slots (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku_id     bigint NOT NULL REFERENCES core.skus(id) ON DELETE CASCADE,
  slot       text NOT NULL,                          -- 例: 'GPU', 'MEMORY'
  category   text NOT NULL,
  qty        integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (sku_id, slot)
);

CREATE TABLE core.sku_slot_options (
  slot_id       bigint NOT NULL REFERENCES core.sku_slots(id) ON DELETE CASCADE,
  part_model_id bigint NOT NULL REFERENCES core.part_models(id),
  PRIMARY KEY (slot_id, part_model_id)
);

-- ---------------------------------------------------------------------
-- 仕入れ
-- ---------------------------------------------------------------------
CREATE TABLE core.suppliers (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  kind           text NOT NULL DEFAULT 'shop' CHECK (kind IN ('shop','distributor','other')),
  invoice_reg_no text CHECK (invoice_reg_no ~ '^T[0-9]{13}$'),  -- インボイス登録番号
  website        text,
  rma_contact    text,                                           -- 代理店のRMA窓口
  notes          text
);

CREATE TABLE core.purchases (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id       bigint NOT NULL REFERENCES core.suppliers(id),
  supplier_order_no text,
  ordered_on        date NOT NULL,
  total_amount      bigint NOT NULL CHECK (total_amount >= 0),   -- 税込
  tax_amount        bigint NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  payment_method    text NOT NULL CHECK (payment_method IN ('card','bank','cash','cod','other')),
  status            text NOT NULL DEFAULT 'ordered'
                      CHECK (status IN ('ordered','partially_received','received','cancelled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, supplier_order_no)
);

CREATE TABLE core.purchase_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id     bigint NOT NULL REFERENCES core.purchases(id) ON DELETE CASCADE,
  part_model_id   bigint REFERENCES core.part_models(id),        -- 読み取り直後は未確定でもよい
  description     text NOT NULL,
  qty             integer NOT NULL CHECK (qty > 0),
  unit_price      bigint NOT NULL CHECK (unit_price >= 0),       -- 税込単価
  unit_tax        bigint NOT NULL DEFAULT 0 CHECK (unit_tax >= 0)
);

-- ---------------------------------------------------------------------
-- 在庫: 部品（1個ずつ）と個体（管理番号）
-- ---------------------------------------------------------------------
CREATE TABLE core.part_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  part_model_id    bigint NOT NULL REFERENCES core.part_models(id),
  purchase_line_id bigint REFERENCES core.purchase_lines(id),
  serial_no        text,
  cost_excl_tax    bigint NOT NULL CHECK (cost_excl_tax >= 0),   -- 原価（税抜）
  cost_tax         bigint NOT NULL DEFAULT 0 CHECK (cost_tax >= 0),
  status           text NOT NULL DEFAULT 'in_stock' CHECK (status IN
                     ('in_stock','installed','in_rma','scrapped','sold','transferred')),
  asset_class      text NOT NULL DEFAULT 'parts_inventory' CHECK (asset_class IN
                     ('parts_inventory','shooting','internal_use','scrapped')),
  box_kept         boolean NOT NULL DEFAULT false,
  box_location     text,                                          -- 元箱の棚番 例: B-07
  received_at      timestamptz NOT NULL DEFAULT now(),
  notes            text,
  CHECK (NOT box_kept OR box_location IS NOT NULL)
);
CREATE UNIQUE INDEX part_items_serial_uq ON core.part_items (part_model_id, serial_no)
  WHERE serial_no IS NOT NULL;
CREATE INDEX ON core.part_items (status, part_model_id);

-- 管理番号の連番（年月ごと）
CREATE TABLE core.mgmt_no_counters (
  yymm    text PRIMARY KEY CHECK (yymm ~ '^[0-9]{4}$'),
  last_no integer NOT NULL
);

-- 次の管理番号を発行する。例: ZB-2610-0051
CREATE FUNCTION core.next_mgmt_no(p_on date DEFAULT current_date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_yymm text := to_char(p_on, 'YYMM');
  v_no   integer;
BEGIN
  INSERT INTO core.mgmt_no_counters AS c (yymm, last_no) VALUES (v_yymm, 1)
  ON CONFLICT (yymm) DO UPDATE SET last_no = c.last_no + 1
  RETURNING last_no INTO v_no;
  IF v_no > 9999 THEN
    RAISE EXCEPTION '% の管理番号が上限（9999）を超えました', v_yymm;
  END IF;
  RETURN 'ZB-' || v_yymm || '-' || lpad(v_no::text, 4, '0');
END $$;

-- QR用の推測されにくいトークン（URLに使える文字だけ）
CREATE FUNCTION core.new_qr_token() RETURNS text
LANGUAGE sql AS $$
  SELECT translate(rtrim(encode(gen_random_bytes(18), 'base64'), '='), '+/', '-_')
$$;

CREATE TABLE core.units (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mgmt_no           text NOT NULL UNIQUE DEFAULT core.next_mgmt_no()
                      CHECK (mgmt_no ~ '^ZB-[0-9]{4}-[0-9]{4}$'),
  sku_id            bigint NOT NULL REFERENCES core.skus(id),
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN
                      ('planned','assembling','inspecting','ready','inbound_to_fba','at_fba',
                       'shipped','returned','in_repair','scrapped')),
  asset_class       text NOT NULL DEFAULT 'product' CHECK (asset_class IN
                      ('product','shooting','internal_use','demo_resale','scrapped')),
  qr_token          text NOT NULL UNIQUE DEFAULT core.new_qr_token(),
  assembled_by      bigint REFERENCES core.users(id),
  assembled_at      timestamptz,
  inspected_by      bigint REFERENCES core.users(id),
  inspected_at      timestamptz,
  shipped_at        timestamptz,                 -- 自社から出た日（FBA納品または顧客へ直送）
  ship_destination  text CHECK (ship_destination IN ('fba','customer','other')),
  warranty_months   integer NOT NULL DEFAULT 12 CHECK (warranty_months IN (12, 24)),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (inspected_by IS NULL OR assembled_by IS NULL OR inspected_by <> assembled_by)  -- 検品は組立と別の人
);
CREATE INDEX ON core.units (sku_id, status);
CREATE TRIGGER units_touch BEFORE UPDATE ON core.units
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

-- 個体に入っている部品。修理で交換したら removed_at を入れて新しい行を足す（履歴が残る）
CREATE TABLE core.unit_parts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id         bigint NOT NULL REFERENCES core.units(id),
  part_item_id    bigint NOT NULL REFERENCES core.part_items(id),
  slot            text NOT NULL,
  installed_at    timestamptz NOT NULL DEFAULT now(),
  installed_by    bigint REFERENCES core.users(id),
  override_reason text,                          -- 構成表にない型番をあえて使うときの理由
  removed_at      timestamptz,
  removed_by      bigint REFERENCES core.users(id),
  remove_reason   text,
  CHECK (removed_at IS NULL OR remove_reason IS NOT NULL)
);
CREATE UNIQUE INDEX unit_parts_active_uq ON core.unit_parts (part_item_id) WHERE removed_at IS NULL;
CREATE INDEX ON core.unit_parts (unit_id);

-- 構成表にない型番を取り付けようとしたら止める（理由を書けば通す）。
-- 取り付け・取り外しに合わせて部品の状態も変える。
CREATE FUNCTION core.unit_parts_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM core.units u
      JOIN core.sku_slots s        ON s.sku_id = u.sku_id AND s.slot = NEW.slot
      JOIN core.sku_slot_options o ON o.slot_id = s.id
      JOIN core.part_items p       ON p.part_model_id = o.part_model_id
      WHERE u.id = NEW.unit_id AND p.id = NEW.part_item_id
    ) INTO v_ok;
    IF NOT v_ok AND NEW.override_reason IS NULL THEN
      RAISE EXCEPTION '構成表にない部品です（枠: %）。使う場合は override_reason に理由を書いてください', NEW.slot;
    END IF;
    UPDATE core.part_items SET status = 'installed' WHERE id = NEW.part_item_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
    UPDATE core.part_items SET status = 'in_stock'
     WHERE id = NEW.part_item_id AND status = 'installed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unit_parts_check BEFORE INSERT OR UPDATE ON core.unit_parts
  FOR EACH ROW EXECUTE FUNCTION core.unit_parts_check();

CREATE TABLE core.inspections (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id             bigint NOT NULL REFERENCES core.units(id),
  inspector_id        bigint NOT NULL REFERENCES core.users(id),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  stress_test_minutes integer CHECK (stress_test_minutes >= 0),
  max_cpu_temp_c      numeric(5,1),
  max_gpu_temp_c      numeric(5,1),
  noise_db            numeric(5,1),
  checklist           jsonb NOT NULL DEFAULT '{}'::jsonb,
  result              text CHECK (result IN ('pass','fail')),
  note                text
);

-- 区分の振替（撮影用への転用、社内利用、廃棄など。仕様書 F7）
CREATE TABLE core.asset_transfers (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('part_item','unit')),
  subject_id   bigint NOT NULL,
  from_class   text NOT NULL,
  to_class     text NOT NULL,
  amount       bigint NOT NULL CHECK (amount >= 0),   -- 振替時点の原価（税抜）
  reason       text NOT NULL,
  requested_by bigint REFERENCES core.users(id),
  approved_by  bigint REFERENCES core.users(id),
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_class <> to_class)
);

-- FBA納品
CREATE TABLE core.fba_shipments (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amazon_shipment_id text UNIQUE,
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','shipped','receiving','closed','cancelled')),
  shipped_at         timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.fba_shipment_units (
  shipment_id bigint NOT NULL REFERENCES core.fba_shipments(id),
  unit_id     bigint NOT NULL REFERENCES core.units(id),
  PRIMARY KEY (shipment_id, unit_id)
);

-- SP-API から定期的に取るFBA在庫
CREATE TABLE core.fba_inventory_snapshots (
  captured_at   timestamptz NOT NULL,
  sku_id        bigint NOT NULL REFERENCES core.skus(id),
  fulfillable   integer NOT NULL DEFAULT 0,
  inbound       integer NOT NULL DEFAULT 0,
  reserved      integer NOT NULL DEFAULT 0,
  unfulfillable integer NOT NULL DEFAULT 0,
  PRIMARY KEY (sku_id, captured_at)
);

-- ---------------------------------------------------------------------
-- 顧客・注文・製品登録
-- ---------------------------------------------------------------------
-- 業務データ側の顧客は番号だけ。氏名などは pii.customer_profiles にある
CREATE SEQUENCE core.customer_no_seq;
CREATE TABLE core.customers (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_no  text NOT NULL UNIQUE
                 DEFAULT 'C-' || lpad(nextval('core.customer_no_seq')::text, 6, '0'),
  is_corporate boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.orders (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel           text NOT NULL CHECK (channel IN ('amazon','direct','marketplace','corporate','other')),
  external_order_no text NOT NULL,              -- Amazonの注文番号など
  is_fba            boolean NOT NULL DEFAULT false,
  ordered_at        timestamptz NOT NULL,
  delivered_at      timestamptz,
  total_amount      bigint NOT NULL CHECK (total_amount >= 0),
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','shipped','delivered','cancelled','returned')),
  customer_id       bigint REFERENCES core.customers(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_order_no),
  CHECK (NOT is_fba OR channel = 'amazon')
);

CREATE TABLE core.order_lines (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES core.orders(id) ON DELETE CASCADE,
  sku_id      bigint REFERENCES core.skus(id),
  description text NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  unit_price  bigint NOT NULL CHECK (unit_price >= 0)
);

-- 注文と個体の紐づけ。FBAは出荷時点では分からないので、製品登録や問い合わせのときに紐づける
CREATE TABLE core.order_units (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      bigint NOT NULL REFERENCES core.orders(id),
  unit_id       bigint NOT NULL REFERENCES core.units(id),
  link_method   text NOT NULL CHECK (link_method IN ('shipping','product_registration','support','manual')),
  linked_at     timestamptz NOT NULL DEFAULT now(),
  linked_by     bigint REFERENCES core.users(id),
  unlinked_at   timestamptz,
  unlink_reason text,
  CHECK (unlinked_at IS NULL OR unlink_reason IS NOT NULL)
);
CREATE UNIQUE INDEX order_units_active_uq ON core.order_units (unit_id) WHERE unlinked_at IS NULL;

-- 注文に含まれないSKUの個体は紐づけられない。注文の台数を超えても紐づけられない
CREATE FUNCTION core.order_units_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sku     bigint;
  v_ordered integer;
  v_linked  integer;
BEGIN
  IF NEW.unlinked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT sku_id INTO v_sku FROM core.units WHERE id = NEW.unit_id;
  SELECT coalesce(sum(qty), 0) INTO v_ordered
    FROM core.order_lines WHERE order_id = NEW.order_id AND sku_id = v_sku;
  IF v_ordered = 0 THEN
    RAISE EXCEPTION 'この注文にはこの個体のSKUが含まれていません';
  END IF;
  SELECT count(*) INTO v_linked
    FROM core.order_units ou JOIN core.units u ON u.id = ou.unit_id
   WHERE ou.order_id = NEW.order_id AND u.sku_id = v_sku
     AND ou.unlinked_at IS NULL AND ou.id IS DISTINCT FROM NEW.id;
  IF v_linked >= v_ordered THEN
    RAISE EXCEPTION 'この注文のこのSKUには、すでに注文台数分（%台）の個体が紐づいています', v_ordered;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_units_check BEFORE INSERT OR UPDATE ON core.order_units
  FOR EACH ROW EXECUTE FUNCTION core.order_units_check();

-- QRからの製品登録（仕様書 F4）
CREATE TABLE core.product_registrations (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id           bigint NOT NULL UNIQUE REFERENCES core.units(id),
  customer_id       bigint NOT NULL REFERENCES core.customers(id),
  order_id          bigint REFERENCES core.orders(id),
  registered_at     timestamptz NOT NULL DEFAULT now(),
  verification      text NOT NULL DEFAULT 'pending'
                      CHECK (verification IN ('pending','verified','failed','not_required')),
  verification_note text
);

-- ---------------------------------------------------------------------
-- 顧客の個人情報（pii）
-- 値はアプリ側で暗号化して bytea で保存する。鍵は Secret Manager に置く。
-- 検索に使う項目は、正規化した値の HMAC を *_hash に入れる。
-- ---------------------------------------------------------------------
CREATE TABLE pii.customer_profiles (
  customer_id       bigint PRIMARY KEY REFERENCES core.customers(id),
  name_enc          bytea,
  name_kana_enc     bytea,
  company_enc       bytea,
  email_enc         bytea,
  email_hash        bytea,
  phone_enc         bytea,
  phone_hash        bytea,
  postal_code_enc   bytea,
  address_enc       bytea,
  line_user_id_enc  bytea,
  line_user_id_hash bytea,
  consent_marketing boolean NOT NULL DEFAULT false,  -- 販促連絡への同意（初期値は同意なし）
  retention_until   date,                            -- この日を過ぎたら削除または匿名化
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pii.customer_profiles (email_hash);
CREATE INDEX ON pii.customer_profiles (phone_hash);
CREATE UNIQUE INDEX customer_profiles_line_uq ON pii.customer_profiles (line_user_id_hash)
  WHERE line_user_id_hash IS NOT NULL;
CREATE TRIGGER customer_profiles_touch BEFORE UPDATE ON pii.customer_profiles
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

-- ---------------------------------------------------------------------
-- 受信箱: 会話とメッセージ（本文は個人情報を含みうるので pii 側に置く）
-- ---------------------------------------------------------------------
CREATE TABLE core.conversations (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel            text NOT NULL CHECK (channel IN ('line','amazon','gmail')),
  mailbox            text,                          -- Gmailの受信アドレス 例: info@
  external_thread_id text NOT NULL,
  subject            text,
  customer_id        bigint REFERENCES core.customers(id),
  unit_id            bigint REFERENCES core.units(id),
  order_id           bigint REFERENCES core.orders(id),
  status             text NOT NULL DEFAULT 'needs_reply'
                       CHECK (status IN ('needs_reply','waiting_customer','closed','spam')),
  spam_reason        text,
  reply_due_at       timestamptz,
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_thread_id),
  CHECK (status <> 'spam' OR spam_reason IS NOT NULL)
);
CREATE INDEX ON core.conversations (status, reply_due_at);

CREATE TABLE core.messages (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id     bigint NOT NULL REFERENCES core.conversations(id),
  direction           text NOT NULL CHECK (direction IN ('in','out')),
  author_kind         text NOT NULL CHECK (author_kind IN ('customer','staff','auto_reply','ai_draft')),
  status              text NOT NULL CHECK (status IN ('received','draft','approved','sent','discarded')),
  ai_call_id          bigint,                       -- 下書きを作ったAI呼び出し（外部キーは後で追加）
  approved_by         bigint REFERENCES core.users(id),
  approved_at         timestamptz,
  sent_at             timestamptz,
  external_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (direction = 'out' OR (author_kind = 'customer' AND status = 'received')),
  -- AIの下書きは、人が承認してからでないと送信済みにできない（自動応答は除く）
  CHECK (NOT (author_kind = 'ai_draft' AND status = 'sent') OR approved_by IS NOT NULL)
);
CREATE INDEX ON core.messages (conversation_id, created_at);

CREATE TABLE pii.message_bodies (
  message_id  bigint PRIMARY KEY REFERENCES core.messages(id),
  body_enc    bytea NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb    -- ファイル保管場所への参照だけを持つ
);

-- ---------------------------------------------------------------------
-- 修理・RMA
-- ---------------------------------------------------------------------
CREATE TABLE core.repair_tickets (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id              bigint NOT NULL REFERENCES core.units(id),
  conversation_id      bigint REFERENCES core.conversations(id),
  symptom              text NOT NULL,
  coverage             text NOT NULL CHECK (coverage IN ('warranty','paid','goodwill')),
  estimate_amount      bigint CHECK (estimate_amount >= 0),
  estimate_approved_at timestamptz,                -- お客様が見積に同意した日時
  status               text NOT NULL DEFAULT 'received' CHECK (status IN
                         ('received','diagnosing','waiting_parts','repairing','returned','cancelled')),
  received_at          timestamptz NOT NULL DEFAULT now(),
  returned_at          timestamptz,
  note                 text,
  CHECK (coverage <> 'paid' OR estimate_amount IS NOT NULL)
);

CREATE TABLE core.rma_cases (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  part_item_id             bigint NOT NULL REFERENCES core.part_items(id),
  supplier_id              bigint NOT NULL REFERENCES core.suppliers(id),
  repair_ticket_id         bigint REFERENCES core.repair_tickets(id),
  rma_no                   text,
  reason                   text NOT NULL,
  status                   text NOT NULL DEFAULT 'preparing' CHECK (status IN
                             ('preparing','sent','replaced','refunded','rejected')),
  sent_at                  timestamptz,
  resolved_at              timestamptz,
  replacement_part_item_id bigint REFERENCES core.part_items(id)
);

-- ---------------------------------------------------------------------
-- 証憑・書類（電子帳簿保存法の検索項目: 日付・金額・取引先）
-- ファイル本体は Cloud Storage。ここには場所とハッシュだけを持つ
-- ---------------------------------------------------------------------
CREATE TABLE core.documents (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN
                   ('receipt','invoice','delivery_note','quote','warranty_card','setup_guide',
                    'photo','rma_form','filing','contract','other')),
  storage_uri    text NOT NULL UNIQUE,              -- gs://...
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type      text NOT NULL,
  byte_size      bigint NOT NULL CHECK (byte_size >= 0),
  source         text NOT NULL CHECK (source IN ('email','upload','generated','scan')),
  issued_on      date,
  counterparty   text,
  amount         bigint,
  invoice_reg_no text CHECK (invoice_reg_no ~ '^T[0-9]{13}$'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON core.documents (issued_on, amount, counterparty);

-- 書類と、それが関係するデータの紐づけ（1つの領収書が仕入れと部品の両方に関係するなど）
CREATE TABLE core.document_links (
  document_id bigint NOT NULL REFERENCES core.documents(id),
  entity_type text NOT NULL CHECK (entity_type IN
                ('purchase','part_item','unit','order','repair_ticket','rma_case','deal','task','inspection')),
  entity_id   bigint NOT NULL,
  PRIMARY KEY (document_id, entity_type, entity_id)
);

-- ---------------------------------------------------------------------
-- 会計: freee へ送る取引と、その元データ
-- ---------------------------------------------------------------------
CREATE TABLE core.amazon_settlements (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id text NOT NULL UNIQUE,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  deposit_date  date,
  total_amount  bigint NOT NULL,
  document_id   bigint REFERENCES core.documents(id)
);

-- カード・口座の明細（領収書との突き合わせ用。二重計上を防ぐ）
CREATE TABLE core.statement_lines (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account             text NOT NULL,                -- 例: 'card:main', 'bank:main'
  posted_on           date NOT NULL,
  amount              bigint NOT NULL,              -- 出金はマイナス
  description         text NOT NULL,
  external_id         text,
  matched_purchase_id bigint REFERENCES core.purchases(id),
  UNIQUE (account, external_id)
);

CREATE TABLE core.deals (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type   text NOT NULL CHECK (source_type IN
                  ('amazon_settlement','purchase','statement_line','direct_sale','inventory_close','manual')),
  source_id     bigint,
  deal_date     date NOT NULL,
  amount        bigint NOT NULL,
  department    text NOT NULL CHECK (department IN ('manufacturing','sales','marketing','admin')),
  account_item  text NOT NULL,                      -- 勘定科目（freee の名称）
  tax_code      text,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','needs_review','registered','skipped')),
  review_reason text,
  freee_deal_id text UNIQUE,
  registered_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'needs_review' OR review_reason IS NOT NULL),
  CHECK (status <> 'registered' OR freee_deal_id IS NOT NULL),
  UNIQUE (source_type, source_id, account_item)     -- 同じ元データから同じ科目を二重に作らない
);

-- ---------------------------------------------------------------------
-- 売上・広告の指標（Amazonのビジネスレポートと広告レポート）
-- ---------------------------------------------------------------------
CREATE TABLE core.sku_daily_metrics (
  metric_date    date NOT NULL,
  sku_id         bigint NOT NULL REFERENCES core.skus(id),
  channel        text NOT NULL CHECK (channel IN ('amazon','direct')),
  sessions       integer,
  page_views     integer,
  units_ordered  integer,
  sales_amount   bigint,
  ad_impressions integer,
  ad_clicks      integer,
  ad_spend       bigint,
  ad_sales       bigint,
  PRIMARY KEY (metric_date, sku_id, channel)
);

-- ---------------------------------------------------------------------
-- タスクと承認（仕様書4章）
-- ---------------------------------------------------------------------
CREATE TABLE core.approvals (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type       text NOT NULL,                 -- 例: 'message', 'deal', 'asset_transfer'
  subject_id         bigint NOT NULL,
  approver_role_code text NOT NULL REFERENCES core.roles(code),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         bigint REFERENCES core.users(id),
  decided_at         timestamptz,
  decision           text CHECK (decision IN ('approved','rejected')),
  note               text,
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (decision IS NULL OR decided_by IS NOT NULL)
);

CREATE TABLE core.tasks (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title                text NOT NULL,
  description          text,
  role_code            text NOT NULL REFERENCES core.roles(code),   -- 責任を持つ役割
  assignee_user_id     bigint REFERENCES core.users(id),            -- 作成時点でその役割を持っていた人
  approver_role_code   text REFERENCES core.roles(code),
  source_kind          text NOT NULL CHECK (source_kind IN ('calendar','fba','inbox','ai','manual','system')),
  source_ref           text,                                        -- 例: 'conversation:123'
  due_at               timestamptz,
  planned_at           timestamptz,
  status               text NOT NULL DEFAULT 'todo'
                         CHECK (status IN ('todo','in_progress','awaiting_approval','done','cancelled')),
  completed_at         timestamptz,
  completed_by_kind    text CHECK (completed_by_kind IN ('user','system','ai')),
  completed_by_user_id bigint REFERENCES core.users(id),
  approval_id          bigint REFERENCES core.approvals(id),        -- システム・AIが実行した根拠の承認
  evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,          -- 送信ID、受付番号など
  delay_reason         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'done' OR (completed_at IS NOT NULL AND completed_by_kind IS NOT NULL)),
  CHECK (completed_by_kind IS DISTINCT FROM 'user' OR completed_by_user_id IS NOT NULL),
  -- 期限を過ぎて完了したら遅延の理由が必要
  CHECK (status <> 'done' OR due_at IS NULL OR completed_at <= due_at OR delay_reason IS NOT NULL)
);
CREATE INDEX ON core.tasks (role_code, status, due_at);

-- タスクの出来事の記録（追記のみ）
CREATE TABLE core.task_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id       bigint NOT NULL REFERENCES core.tasks(id),
  at            timestamptz NOT NULL DEFAULT now(),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user','system','ai')),
  actor_user_id bigint REFERENCES core.users(id),
  event         text NOT NULL,                     -- created, started, approved, completed, cancelled, comment
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER task_events_append_only BEFORE UPDATE OR DELETE ON core.task_events
  FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

-- ---------------------------------------------------------------------
-- AI: プロンプトの版、呼び出し記録、ローカルLLMが取りに来る仕事の列
-- ---------------------------------------------------------------------
CREATE TABLE core.prompts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,                        -- 例: 'amazon_reply_draft'
  version    integer NOT NULL CHECK (version > 0),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE core.ai_calls (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route         text NOT NULL CHECK (route IN ('local','claude')),
  model         text NOT NULL,                     -- 例: 'claude-opus-5-5'、ローカルはモデル名
  model_version text NOT NULL,                     -- ローカルはモデルファイルのハッシュなど
  prompt_id     bigint REFERENCES core.prompts(id),
  purpose       text NOT NULL,
  contains_pii  boolean NOT NULL,
  masked        boolean NOT NULL DEFAULT false,
  status        text NOT NULL CHECK (status IN ('ok','error','blocked')),
  input_sha256  text,
  latency_ms    integer,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 個人情報を伏せずに Claude へ送った記録は作れない（仕様書5章）
  CHECK (route <> 'claude' OR NOT contains_pii OR masked)
);

ALTER TABLE core.messages
  ADD CONSTRAINT messages_ai_call_fk FOREIGN KEY (ai_call_id) REFERENCES core.ai_calls(id);

CREATE TABLE core.ai_jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,                      -- 例: 'draft_reply', 'read_receipt', 'classify_mail'
  route        text NOT NULL CHECK (route IN ('local','claude')),
  subject_type text NOT NULL,
  subject_id   bigint NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','done','failed')),
  priority     integer NOT NULL DEFAULT 0,
  attempts     integer NOT NULL DEFAULT 0,
  claimed_by   text,                               -- 取りに来たサーバーの名前
  lease_until  timestamptz,                        -- この時刻までに終わらなければ取り直せる
  ai_call_id   bigint REFERENCES core.ai_calls(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX ai_jobs_queue_idx ON core.ai_jobs (route, status, priority DESC, created_at)
  WHERE status IN ('queued','claimed');

-- ローカルLLMサーバーが次の仕事を1件取る（同時に取り合っても重ならない）
CREATE FUNCTION core.claim_ai_job(p_worker text, p_route text DEFAULT 'local',
                                  p_lease interval DEFAULT interval '10 minutes')
RETURNS SETOF core.ai_jobs
LANGUAGE sql AS $$
  UPDATE core.ai_jobs j
     SET status = 'claimed', claimed_by = p_worker, lease_until = now() + p_lease,
         attempts = j.attempts + 1
   WHERE j.id = (
     SELECT id FROM core.ai_jobs
      WHERE route = p_route
        AND (status = 'queued' OR (status = 'claimed' AND lease_until < now()))
      ORDER BY priority DESC, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
  RETURNING j.*
$$;

-- ---------------------------------------------------------------------
-- 監査ログ（追記のみ）
-- ---------------------------------------------------------------------
CREATE TABLE audit.log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  actor_kind      text NOT NULL,
  actor_user_id   bigint,
  table_name      text NOT NULL,
  row_id          text,
  action          text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  changed_columns text[],
  before          jsonb,      -- pii の表では値を残さない（列名だけ）
  after           jsonb,
  txid            bigint NOT NULL DEFAULT txid_current()
);
CREATE INDEX ON audit.log (table_name, row_id);
CREATE INDEX ON audit.log (at);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit.log
  FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

CREATE FUNCTION audit.record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_kind    text   := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'system');
  v_user    bigint := nullif(current_setting('app.actor_user_id', true), '')::bigint;
  v_old     jsonb  := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new     jsonb  := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  v_cols    text[];
  v_is_pii  boolean := (TG_TABLE_SCHEMA = 'pii');
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
          CASE WHEN v_is_pii THEN NULL ELSE v_old END,
          CASE WHEN v_is_pii THEN NULL ELSE v_new END);
  RETURN coalesce(NEW, OLD);
END $$;

-- 監査ログを取る表（第1引数は主キーの列名）
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('core','settings','key'), ('core','users','id'), ('core','role_assignments','id'),
    ('core','part_models','id'), ('core','skus','id'), ('core','sku_slots','id'),
    ('core','suppliers','id'), ('core','purchases','id'), ('core','purchase_lines','id'),
    ('core','part_items','id'), ('core','units','id'), ('core','unit_parts','id'),
    ('core','inspections','id'), ('core','asset_transfers','id'), ('core','fba_shipments','id'),
    ('core','customers','id'), ('core','orders','id'), ('core','order_units','id'),
    ('core','product_registrations','id'), ('core','conversations','id'), ('core','messages','id'),
    ('core','repair_tickets','id'), ('core','rma_cases','id'), ('core','documents','id'),
    ('core','deals','id'), ('core','approvals','id'), ('core','tasks','id'), ('core','prompts','id'),
    ('pii','customer_profiles','customer_id'), ('pii','message_bodies','message_id')
  ) AS t(sch, tbl, pk)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%s AFTER INSERT OR UPDATE OR DELETE ON %I.%I
         FOR EACH ROW EXECUTE FUNCTION audit.record(%L)', r.tbl, r.sch, r.tbl, r.pk);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- よく使う見え方（ビュー）
-- ---------------------------------------------------------------------

-- 保証期間。起算日は「注文日（分かる場合）」、分からなければ自社の出荷日
CREATE VIEW core.v_unit_warranty AS
SELECT u.id AS unit_id, u.mgmt_no, s.code AS sku_code, u.status,
       coalesce(o.ordered_at, u.shipped_at)::date AS warranty_start,
       (coalesce(o.ordered_at, u.shipped_at) + make_interval(months => u.warranty_months))::date AS warranty_end,
       u.warranty_months,
       (pr.id IS NOT NULL) AS registered
FROM core.units u
JOIN core.skus s ON s.id = u.sku_id
LEFT JOIN core.order_units ou ON ou.unit_id = u.id AND ou.unlinked_at IS NULL
LEFT JOIN core.orders o ON o.id = ou.order_id
LEFT JOIN core.product_registrations pr ON pr.unit_id = u.id;

-- タスク一覧（期限超過は保存せず、ここで計算する）
CREATE VIEW core.v_task_board AS
SELECT t.*,
       r.name AS role_name,
       (t.status IN ('todo','in_progress','awaiting_approval') AND t.due_at < now()) AS overdue
FROM core.tasks t
JOIN core.roles r ON r.code = t.role_code;

-- FBA在庫の残り日数と、組立を始める期限（仕様書 F5）
CREATE VIEW core.v_fba_runway AS
WITH cfg AS (
  SELECT (SELECT (value #>> '{}')::int FROM core.settings WHERE key = 'fba_lead_time_days')     AS lead_days,
         (SELECT (value #>> '{}')::int FROM core.settings WHERE key = 'sales_pace_window_days') AS window_days
), latest AS (
  SELECT DISTINCT ON (sku_id) sku_id, captured_at, fulfillable, inbound
  FROM core.fba_inventory_snapshots
  ORDER BY sku_id, captured_at DESC
), pace AS (
  SELECT m.sku_id, sum(m.units_ordered)::numeric / max(cfg.window_days) AS per_day
  FROM core.sku_daily_metrics m, cfg
  WHERE m.channel = 'amazon' AND m.metric_date > current_date - cfg.window_days
  GROUP BY m.sku_id
)
SELECT s.id AS sku_id, s.code AS sku_code,
       l.fulfillable, l.inbound,
       round(p.per_day, 2) AS per_day,
       CASE WHEN p.per_day > 0 THEN round((l.fulfillable + l.inbound) / p.per_day, 1) END AS days_left,
       CASE WHEN p.per_day > 0
            THEN current_date + floor((l.fulfillable + l.inbound) / p.per_day)::int - cfg.lead_days END
         AS start_assembly_by
FROM core.skus s
CROSS JOIN cfg
JOIN latest l ON l.sku_id = s.id
LEFT JOIN pace p ON p.sku_id = s.id
WHERE s.active;

COMMIT;
