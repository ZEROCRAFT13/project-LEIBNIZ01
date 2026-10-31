-- =====================================================================
-- 書類（領収書・保証書・納品書など）の取り込み
--   ・取り込んだファイルは書き換えも削除もできない（電子帳簿保存法。直すのは日付・金額などの項目だけで、
--     その履歴は監査ログに残る）
--   ・同じファイル（中身が同じ）は二重に取り込まない
--   ・領収書・請求書は、日付・取引先・金額がそろうまで「要確認」のまま
-- =====================================================================

BEGIN;

ALTER TABLE core.documents
  ADD COLUMN original_name text CHECK (length(original_name) <= 255),   -- 取り込んだときのファイル名
  ADD COLUMN received_at   timestamptz NOT NULL DEFAULT now(),           -- 取り込んだ時刻
  ADD COLUMN review_status text NOT NULL DEFAULT 'needs_review'
                           CHECK (review_status IN ('needs_review', 'done')),
  ADD CONSTRAINT documents_sha256_uq UNIQUE (sha256),
  ADD CONSTRAINT documents_done_needs_fields CHECK (
    review_status <> 'done'
    OR kind NOT IN ('receipt', 'invoice')
    OR (issued_on IS NOT NULL AND counterparty IS NOT NULL AND amount IS NOT NULL)
  );

-- 取り込み元に「共有の取り込みフォルダ」を足す
ALTER TABLE core.documents DROP CONSTRAINT documents_source_check;
ALTER TABLE core.documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('email', 'upload', 'generated', 'scan', 'folder'));

CREATE INDEX ON core.documents (review_status, received_at);

-- ファイルそのものにかかわる列は変えられない
CREATE FUNCTION core.documents_keep_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_uri IS DISTINCT FROM OLD.storage_uri
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.original_name IS DISTINCT FROM OLD.original_name
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '取り込んだ書類のファイルは変えられません（直せるのは日付・取引先・金額などの項目だけです）';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER documents_keep_file BEFORE UPDATE ON core.documents
  FOR EACH ROW EXECUTE FUNCTION core.documents_keep_file();
CREATE TRIGGER documents_no_delete BEFORE DELETE ON core.documents
  FOR EACH ROW EXECUTE FUNCTION core.forbid_change();
REVOKE DELETE ON core.documents FROM zb_app;

-- 書類と仕入れなどのひもづけも、誰がいつ付け外ししたかを残す
CREATE TRIGGER audit_document_links AFTER INSERT OR UPDATE OR DELETE ON core.document_links
  FOR EACH ROW EXECUTE FUNCTION audit.record('document_id');

COMMIT;
