-- =====================================================================
-- 検品を3段階にし、写真を残せるようにする（仕様書 F6）
--   ① assembled（組立状態）… 配線・内部。配線の写真が必須
--   ② software （Windows とベンチマーク）… 負荷試験の時間・温度・騒音、ベンチマークの点数
--   ③ final    （出荷直前の最終確認）… 外観・付属品・シール。正常に起動している写真が必須
--   ・1回の記録＝1行（合格でも不合格でも）。記録したら直せない・消せない
--   ・前の段階に合格しないと次の段階を記録できない。組立に戻したら①からやり直す
--     （「今の回」は units.assembled_at より後の記録。組立を完了するたびに assembled_at が新しくなる）
--   ・組み立てた本人は、どの段階も検品できない
--   ・温度・騒音が上限を超えたときは、合格にするのに理由が要る（上限は core.settings。判定はアプリが計算する）
--   ・写真は撮った時刻・撮った人・中身のハッシュを残し、ファイルは上書きしない。
--     段階の記録に使った写真は取り消せない
-- =====================================================================

BEGIN;

-- 検品を任せる役割（代表・工場長のほかに、バイトに付ける）
INSERT INTO core.roles (code, name, description) VALUES
  ('inspector', '検品担当', '検品（組み立てた本人以外）。バイトに任せるときに付ける');

-- ---------- 段階ごとの記録 ----------
ALTER TABLE core.inspections
  ADD COLUMN stage          text CHECK (stage IN ('assembled', 'software', 'final')),
  ADD COLUMN benchmarks     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(benchmarks) = 'array'),
  ADD COLUMN warnings       text[] NOT NULL DEFAULT '{}',   -- 上限を超えた項目（例「CPU 92.0℃（上限 90℃）」）
  ADD COLUMN warning_reason text,                            -- 上限を超えても合格にした理由
  ADD COLUMN next_action    text CHECK (next_action IN ('retry', 'rework'));  -- 不合格のあと：やり直す／組立に戻す

-- これまでの1回だけの検品（ダミーデータなど）は「最終確認」とみなす
UPDATE core.inspections SET stage = 'final' WHERE stage IS NULL;
ALTER TABLE core.inspections
  ALTER COLUMN stage SET NOT NULL,
  ALTER COLUMN result SET NOT NULL,
  ALTER COLUMN finished_at SET DEFAULT now(),
  ADD CONSTRAINT inspections_temps CHECK (
    (max_cpu_temp_c IS NULL OR max_cpu_temp_c BETWEEN 0 AND 150)
    AND (max_gpu_temp_c IS NULL OR max_gpu_temp_c BETWEEN 0 AND 150)
    AND (noise_db IS NULL OR noise_db BETWEEN 0 AND 120)),
  -- ②に合格するには、負荷試験の時間と CPU の最高温度が要る（GPU を積まない機種もあるので GPU は任意）
  ADD CONSTRAINT inspections_software_measured CHECK (
    stage <> 'software' OR result <> 'pass'
    OR (stress_test_minutes IS NOT NULL AND max_cpu_temp_c IS NOT NULL)),
  ADD CONSTRAINT inspections_warning_reason CHECK (
    result <> 'pass' OR cardinality(warnings) = 0 OR length(btrim(coalesce(warning_reason, ''))) > 0),
  ADD CONSTRAINT inspections_fail_note CHECK (
    result <> 'fail' OR (length(btrim(coalesce(note, ''))) > 0 AND next_action IS NOT NULL)),
  ADD CONSTRAINT inspections_next_action_only_fail CHECK (result = 'fail' OR next_action IS NULL);
CREATE INDEX ON core.inspections (unit_id, finished_at);

-- ---------- 写真 ----------
CREATE TABLE core.inspection_photos (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id       bigint NOT NULL REFERENCES core.units(id),
  stage         text NOT NULL CHECK (stage IN ('assembled', 'software', 'final')),
  kind          text NOT NULL CHECK (kind IN ('wiring', 'benchmark', 'boot', 'other')),
  inspection_id bigint REFERENCES core.inspections(id),  -- 段階を記録したときに、その記録にひもづける
  storage_uri   text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type     text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  taken_by      bigint NOT NULL REFERENCES core.users(id),
  taken_at      timestamptz NOT NULL DEFAULT now(),       -- サーバーが受け取った時刻
  removed_at    timestamptz,
  removed_by    bigint REFERENCES core.users(id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CHECK (removed_at IS NULL OR inspection_id IS NULL),
  CHECK ((stage = 'assembled' AND kind IN ('wiring', 'other'))
      OR (stage = 'software'  AND kind IN ('benchmark', 'other'))
      OR (stage = 'final'     AND kind IN ('boot', 'other')))
);
CREATE INDEX ON core.inspection_photos (unit_id, stage);
CREATE INDEX ON core.inspection_photos (inspection_id);

-- 写真は消さない。中身・撮った人・時刻は変えない。変えてよいのは「記録にひもづける」と「取り消し」だけ
CREATE FUNCTION core.inspection_photos_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '検品の写真は消せません（間違えたときは取り消しにします）';
  END IF;
  IF NEW.unit_id <> OLD.unit_id OR NEW.stage <> OLD.stage OR NEW.kind <> OLD.kind
     OR NEW.storage_uri <> OLD.storage_uri OR NEW.sha256 <> OLD.sha256 OR NEW.mime_type <> OLD.mime_type
     OR NEW.size_bytes <> OLD.size_bytes OR NEW.taken_by <> OLD.taken_by OR NEW.taken_at <> OLD.taken_at THEN
    RAISE EXCEPTION '検品の写真の中身・撮った人・時刻は変えられません';
  END IF;
  IF OLD.inspection_id IS NOT NULL AND NEW.inspection_id IS DISTINCT FROM OLD.inspection_id THEN
    RAISE EXCEPTION '検品の記録に使った写真は、付け替えられません';
  END IF;
  IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION '取り消した写真は戻せません（撮り直してください）';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_photos_guard BEFORE UPDATE OR DELETE ON core.inspection_photos
  FOR EACH ROW EXECUTE FUNCTION core.inspection_photos_guard();
CREATE TRIGGER audit_inspection_photos AFTER INSERT OR UPDATE OR DELETE ON core.inspection_photos
  FOR EACH ROW EXECUTE FUNCTION audit.record('id');

GRANT SELECT, INSERT, UPDATE ON core.inspection_photos TO zb_app;
GRANT USAGE, SELECT ON SEQUENCE core.inspection_photos_id_seq TO zb_app;
GRANT SELECT ON core.inspection_photos TO zb_pii, zb_auditor;

-- ---------- 段階の記録の決まり ----------
-- 記録したら直せない・消せない
CREATE FUNCTION core.inspections_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '検品の記録は直せません・消せません（もう一度検品して、新しく記録してください）';
END $$;
CREATE TRIGGER inspections_immutable BEFORE UPDATE OR DELETE ON core.inspections
  FOR EACH ROW EXECUTE FUNCTION core.inspections_immutable();
REVOKE UPDATE, DELETE ON core.inspections FROM zb_app;

-- 新しく記録するとき：検品中の個体だけ・組み立てた本人ではない・段階の順番・必要な写真
CREATE FUNCTION core.inspections_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_unit   core.units%ROWTYPE;
  v_prev   text;
  v_photo  text;
  v_round  timestamptz;
BEGIN
  SELECT * INTO v_unit FROM core.units WHERE id = NEW.unit_id;
  v_round := coalesce(v_unit.assembled_at, '-infinity');
  IF v_unit.status <> 'inspecting' THEN
    RAISE EXCEPTION '検品中の個体ではありません（今の状態: %）', v_unit.status;
  END IF;
  IF v_unit.assembled_by IS NOT NULL AND NEW.inspector_id = v_unit.assembled_by THEN
    RAISE EXCEPTION '組み立てた本人は検品できません。別の人に検品してもらってください';
  END IF;
  NEW.started_at := least(NEW.started_at, now());
  NEW.finished_at := now();

  -- 今の回（最後に組立を完了してから）に、この段階はもう合格していないか
  IF EXISTS (SELECT 1 FROM core.inspections
              WHERE unit_id = NEW.unit_id AND stage = NEW.stage AND result = 'pass'
                AND finished_at > v_round) THEN
    RAISE EXCEPTION 'この段階はもう合格しています';
  END IF;

  -- 前の段階に合格しているか
  v_prev := CASE NEW.stage WHEN 'software' THEN 'assembled' WHEN 'final' THEN 'software' END;
  IF v_prev IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM core.inspections
        WHERE unit_id = NEW.unit_id AND stage = v_prev AND result = 'pass'
          AND finished_at > v_round) THEN
    RAISE EXCEPTION '前の段階（%）に合格していません', CASE v_prev WHEN 'assembled' THEN '①組立状態' ELSE '②Windows とベンチマーク' END;
  END IF;

  -- 合格には写真が要る（①配線、③起動）。今の回に撮って、まだどの記録にも使っていないもの
  v_photo := CASE NEW.stage WHEN 'assembled' THEN 'wiring' WHEN 'final' THEN 'boot' END;
  IF NEW.result = 'pass' AND v_photo IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM core.inspection_photos
        WHERE unit_id = NEW.unit_id AND stage = NEW.stage AND kind = v_photo
          AND inspection_id IS NULL AND removed_at IS NULL AND taken_at > v_round) THEN
    RAISE EXCEPTION '合格にするには写真が要ります（%）', CASE v_photo WHEN 'wiring' THEN '配線' ELSE '正常に起動している画面' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspections_check BEFORE INSERT ON core.inspections
  FOR EACH ROW EXECUTE FUNCTION core.inspections_check();

-- 検品担当（inspector）の役割は、そのときの役割としてアプリが確かめる。
-- 最終確認に合格したら、個体は「出荷できる（ready）」になり、units.inspected_by / inspected_at が入る（アプリが同じトランザクションで更新）。

-- ---------- 温度・騒音の上限と、チェックリストの初期値 ----------
INSERT INTO core.settings (key, value, description) VALUES
  ('inspection.limits',
   '{"maxCpuTempC": 90, "maxGpuTempC": 85, "maxNoiseDb": 45, "minStressTestMinutes": 60}',
   '検品の上限（超えたら警告。合格にするには理由が要る）と、負荷試験の最低時間（分）'),
  ('inspection.checklist',
   '{
      "assembled": [
        {"label": "配線の取り回し（ファンに当たらない・まとめてある）"},
        {"label": "電源・PCIe・フロントパネルのコネクタがしっかり刺さっている"},
        {"label": "内部の傷・汚れ・ネジの締め忘れがない"},
        {"label": "ファンの向きと回転（仮に電源を入れて確認）"}
      ],
      "software": [
        {"label": "BIOS の更新と設定（XMP/EXPO など）"},
        {"label": "Windows のインストール"},
        {"label": "Windows のライセンス認証"},
        {"label": "Windows Update とドライバー"},
        {"label": "メモリテストでエラーなし"},
        {"label": "SSD の健康状態が正常（CrystalDiskInfo など）"},
        {"label": "USB 端子（前面・背面）"},
        {"label": "音声の出力"},
        {"label": "有線 LAN"},
        {"label": "Wi-Fi・Bluetooth", "na": true}
      ],
      "final": [
        {"label": "外観（傷・汚れ・指紋）"},
        {"label": "付属品（説明書・電源ケーブル・保証書）"},
        {"label": "管理番号シール（本体と箱）"},
        {"label": "起動して画面が映る（出荷直前）"},
        {"label": "梱包（緩衝材・固定）"}
      ]
    }',
   '検品の段階ごとのチェック項目。na: true の項目は「該当なし」を選べる');

COMMIT;
