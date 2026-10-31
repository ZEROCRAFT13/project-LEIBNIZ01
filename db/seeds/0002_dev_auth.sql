-- =====================================================================
-- ダミーのログイン情報（開発用）
--   組立担当のPIN: 佐藤 = 1357、高橋 = 2468
--   代表は Google でログインする（開発中は ZB_DEV_LOGIN=1 で「開発用ログイン」も使える）
-- 組立用の端末は入れていない。画面の「設定 → 組立用の端末」から登録コードを出して登録する。
-- =====================================================================

INSERT INTO auth.worker_pins (user_id, pin_hash, set_by)
SELECT u.id, v.pin_hash, (SELECT id FROM core.users WHERE email = 'owner@zerobit.example')
  FROM (VALUES
    ('sato@zerobit.example',      'scrypt$16384$8$1$--JgrVmKDgyViReRLQ3LlA$p40fX5sEKmoTtBU4jK6qD_eCkDk75OyKwL8xHVlkvuM'),
    ('takahashi@zerobit.example', 'scrypt$16384$8$1$CTmupkP49W9vJHL07N35Pw$W4G0Z7OaiQrjhr5mSyUZ_5YiZ6MI35Ncc0xARxJCn54')
  ) AS v(email, pin_hash)
  JOIN core.users u ON u.email = v.email;
