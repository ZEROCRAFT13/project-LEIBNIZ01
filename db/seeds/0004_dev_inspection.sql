-- 開発用: 高橋（バイト）に検品を任せておく（佐藤が組んだ個体を高橋が検品する、を試せるように）
BEGIN;
SET LOCAL app.actor_kind = 'system';
INSERT INTO core.role_assignments (role_code, user_id, valid_from)
SELECT 'inspector', id, '2026-10-01' FROM core.users WHERE email = 'takahashi@zerobit.example';
COMMIT;
