-- =====================================================================
-- 開発用のダミーデータ（npm run db:seed で入る）
-- すべて作り物。本物の顧客・注文のデータは入れない（CLAUDE.md ルール1）
-- 画面モックアップの例（ZB-2609-0118 など）とそろえてある
-- =====================================================================
\set ON_ERROR_STOP 1

BEGIN;
SET LOCAL app.actor_kind = 'system';

-- ---------- 入力を短くするための一時的な関数 ----------
CREATE FUNCTION pg_temp.usr(p_email text) RETURNS bigint LANGUAGE sql AS
  $$ SELECT id FROM core.users WHERE email = p_email $$;
CREATE FUNCTION pg_temp.pm(p_model_no text) RETURNS bigint LANGUAGE sql AS
  $$ SELECT id FROM core.part_models WHERE model_no = p_model_no $$;
CREATE FUNCTION pg_temp.sku(p_code text) RETURNS bigint LANGUAGE sql AS
  $$ SELECT id FROM core.skus WHERE code = p_code $$;
CREATE FUNCTION pg_temp.unit(p_mgmt_no text) RETURNS bigint LANGUAGE sql AS
  $$ SELECT id FROM core.units WHERE mgmt_no = p_mgmt_no $$;

-- 部品を1個仕入れる（仕入れと明細がなければ作る）。税込価格から税抜原価と税を出す
CREATE FUNCTION pg_temp.buy(p_model_no text, p_serial text, p_supplier text, p_order_no text,
                            p_ordered_on date, p_price bigint, p_box text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_purchase bigint;
  v_line     bigint;
  v_excl     bigint := round(p_price / 1.1);
  v_item     bigint;
BEGIN
  SELECT id INTO v_purchase FROM core.purchases
   WHERE supplier_id = (SELECT id FROM core.suppliers WHERE name = p_supplier)
     AND supplier_order_no = p_order_no;
  IF v_purchase IS NULL THEN
    INSERT INTO core.purchases (supplier_id, supplier_order_no, ordered_on, total_amount, tax_amount,
                                payment_method, status)
    VALUES ((SELECT id FROM core.suppliers WHERE name = p_supplier), p_order_no, p_ordered_on, 0, 0,
            'card', 'received')
    RETURNING id INTO v_purchase;
  END IF;
  INSERT INTO core.purchase_lines (purchase_id, part_model_id, description, qty, unit_price, unit_tax)
  VALUES (v_purchase, pg_temp.pm(p_model_no),
          (SELECT name FROM core.part_models WHERE model_no = p_model_no), 1, p_price, p_price - v_excl)
  RETURNING id INTO v_line;
  UPDATE core.purchases SET total_amount = total_amount + p_price, tax_amount = tax_amount + (p_price - v_excl)
   WHERE id = v_purchase;
  INSERT INTO core.part_items (part_model_id, purchase_line_id, serial_no, cost_excl_tax, cost_tax,
                               box_kept, box_location, received_at)
  VALUES (pg_temp.pm(p_model_no), v_line, p_serial, v_excl, p_price - v_excl,
          p_box IS NOT NULL, p_box, p_ordered_on + 2)
  RETURNING id INTO v_item;
  RETURN v_item;
END $$;

-- 個体に部品を取り付ける
CREATE FUNCTION pg_temp.install(p_mgmt_no text, p_slot text, p_item bigint, p_by text, p_at timestamptz)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO core.unit_parts (unit_id, slot, part_item_id, installed_by, installed_at)
  VALUES (pg_temp.unit(p_mgmt_no), p_slot, p_item, pg_temp.usr(p_by), p_at)
$$;

-- ---------- 人と役割 ----------
INSERT INTO core.users (email, display_name, kind) VALUES
  ('owner@zerobit.example',     '代表',           'owner'),
  ('sato@zerobit.example',      '佐藤（バイト）', 'part_time'),
  ('takahashi@zerobit.example', '高橋（バイト）', 'part_time');

INSERT INTO core.role_assignments (role_code, user_id, valid_from)
SELECT code, pg_temp.usr('owner@zerobit.example'), '2026-08-01' FROM core.roles WHERE code <> 'assembler';
INSERT INTO core.role_assignments (role_code, user_id, valid_from) VALUES
  ('assembler', pg_temp.usr('sato@zerobit.example'),      '2026-08-01'),
  ('assembler', pg_temp.usr('takahashi@zerobit.example'), '2026-09-01');

-- ---------- 仕入先 ----------
INSERT INTO core.suppliers (name, kind, rma_contact) VALUES
  ('ツクモ',           'shop',        NULL),
  ('ドスパラ',         'shop',        NULL),
  ('パソコン工房',     'shop',        NULL),
  ('Amazon',           'shop',        NULL),
  ('ソフト代理店',     'distributor', NULL),
  ('GPU代理店A',       'distributor', 'rma@gpu-distributor-a.example'),
  ('Joshin',           'shop',        NULL);

-- ---------- 部品マスタ ----------
INSERT INTO core.part_models (category, maker, model_no, name, serial_required, keep_box, maker_warranty_months) VALUES
  ('cpu',         'AMD',       '100-100001404WOF', 'Ryzen 7 9700X',            true,  false, 36),
  ('cpu',         'AMD',       '100-100001405WOF', 'Ryzen 5 9600X',            true,  false, 36),
  ('gpu',         'メーカーA', 'RTX5070-A12G',     'GeForce RTX 5070 12GB',    true,  true,  24),
  ('gpu',         'メーカーB', 'RTX5070-B12G',     'GeForce RTX 5070 12GB',    true,  true,  24),
  ('gpu',         'メーカーA', 'RTX5060TI-A16G',   'GeForce RTX 5060 Ti 16GB', true,  true,  24),
  ('motherboard', 'メーカーC', 'B850-ATX',         'B850 ATX',                 true,  false, 12),
  ('memory',      'メーカーM', 'D5-5600-16X2',     'DDR5-5600 32GB（16GB×2）', true,  true,  NULL),
  ('ssd',         'メーカーS', 'NV4-1TB',          'NVMe SSD 1TB Gen4',        true,  false, 60),
  ('psu',         'メーカーP', 'GD850',            '850W 80PLUS Gold',         true,  true,  120),
  ('psu',         'メーカーP', 'GD750',            '750W 80PLUS Gold',         true,  true,  120),
  ('cooler',      'メーカーK', 'AIO240',           '240mm 簡易水冷',           true,  false, 24),
  ('cooler',      'メーカーK', 'AIR120',           '空冷タワー',               true,  false, 24),
  ('case',        'メーカーQ', 'MT-ATX',           'ミドルタワー ATX',         false, false, NULL),
  ('os',          'Microsoft', 'WIN11-HOME',       'Windows 11 Home',          true,  false, NULL);

-- ---------- SKU と構成表 ----------
INSERT INTO core.skus (code, name, list_price) VALUES
  ('ZB-G5070-R7', 'ゲーミングPC RTX 5070 / Ryzen 7', 349800),
  ('ZB-G5060-R5', 'ゲーミングPC RTX 5060 Ti / Ryzen 5', 239800);

INSERT INTO core.sku_slots (sku_id, slot, category, sort_order)
SELECT pg_temp.sku(s.code), v.slot, v.category, v.ord
FROM (VALUES ('ZB-G5070-R7'), ('ZB-G5060-R5')) AS s(code)
CROSS JOIN (VALUES ('CPU','cpu',1), ('GPU','gpu',2), ('MB','motherboard',3), ('MEMORY','memory',4),
                   ('SSD','ssd',5), ('PSU','psu',6), ('COOLER','cooler',7), ('CASE','case',8), ('OS','os',9))
  AS v(slot, category, ord);

INSERT INTO core.sku_slot_options (slot_id, part_model_id)
SELECT s.id, pg_temp.pm(o.model_no)
FROM (VALUES
  ('ZB-G5070-R7','CPU','100-100001404WOF'), ('ZB-G5070-R7','GPU','RTX5070-A12G'), ('ZB-G5070-R7','GPU','RTX5070-B12G'),
  ('ZB-G5070-R7','MB','B850-ATX'), ('ZB-G5070-R7','MEMORY','D5-5600-16X2'), ('ZB-G5070-R7','SSD','NV4-1TB'),
  ('ZB-G5070-R7','PSU','GD850'), ('ZB-G5070-R7','COOLER','AIO240'), ('ZB-G5070-R7','CASE','MT-ATX'),
  ('ZB-G5070-R7','OS','WIN11-HOME'),
  ('ZB-G5060-R5','CPU','100-100001405WOF'), ('ZB-G5060-R5','GPU','RTX5060TI-A16G'), ('ZB-G5060-R5','MB','B850-ATX'),
  ('ZB-G5060-R5','MEMORY','D5-5600-16X2'), ('ZB-G5060-R5','SSD','NV4-1TB'), ('ZB-G5060-R5','PSU','GD750'),
  ('ZB-G5060-R5','COOLER','AIR120'), ('ZB-G5060-R5','CASE','MT-ATX'), ('ZB-G5060-R5','OS','WIN11-HOME')
) AS o(sku, slot, model_no)
JOIN core.sku_slots s ON s.sku_id = pg_temp.sku(o.sku) AND s.slot = o.slot;

-- ---------- 個体 ----------
-- 管理番号は例とそろえるため手で指定し、連番の続きも合わせておく
INSERT INTO core.units (mgmt_no, sku_id, status, assembled_by, assembled_at, inspected_by, inspected_at,
                        shipped_at, ship_destination, warranty_months, notes)
VALUES
  ('ZB-2608-0077', pg_temp.sku('ZB-G5060-R5'), 'shipped',
   pg_temp.usr('takahashi@zerobit.example'), '2026-08-22 15:00+09', pg_temp.usr('owner@zerobit.example'), '2026-08-23 11:00+09',
   '2026-08-24 10:00+09', 'fba', 12, NULL),
  ('ZB-2609-0102', pg_temp.sku('ZB-G5070-R7'), 'shipped',
   pg_temp.usr('sato@zerobit.example'), '2026-09-08 16:00+09', pg_temp.usr('owner@zerobit.example'), '2026-09-09 10:00+09',
   '2026-09-10 10:00+09', 'fba', 12, 'GPUを初期不良で交換済み'),
  ('ZB-2609-0118', pg_temp.sku('ZB-G5070-R7'), 'in_repair',
   pg_temp.usr('sato@zerobit.example'), '2026-09-19 14:00+09', pg_temp.usr('owner@zerobit.example'), '2026-09-20 13:00+09',
   '2026-09-21 10:00+09', 'fba', 24, NULL),
  ('ZB-2609-0119', pg_temp.sku('ZB-G5070-R7'), 'at_fba',
   pg_temp.usr('sato@zerobit.example'), '2026-09-19 17:00+09', pg_temp.usr('owner@zerobit.example'), '2026-09-20 15:00+09',
   '2026-09-21 10:00+09', 'fba', 12, NULL),
  ('ZB-2610-0045', pg_temp.sku('ZB-G5070-R7'), 'assembling',
   pg_temp.usr('sato@zerobit.example'), NULL, NULL, NULL,
   NULL, NULL, 12, NULL);

INSERT INTO core.mgmt_no_counters (yymm, last_no) VALUES ('2608', 77), ('2609', 119), ('2610', 45);

-- ---------- 部品の仕入れと取り付け ----------
-- ZB-2609-0118（モックアップの例。部品原価の合計 269,280円）
SELECT pg_temp.install('ZB-2609-0118', 'CPU',    pg_temp.buy('100-100001404WOF', '9MP3A7731',     'Amazon',       'AMZ-503-1101', '2026-09-08', 52800),  'sato@zerobit.example', '2026-09-19 13:10+09');
SELECT pg_temp.install('ZB-2609-0118', 'GPU',    pg_temp.buy('RTX5070-A12G',     '602-V531-4471', 'ドスパラ',     'DS-88120',     '2026-09-10', 98780, 'B-07'), 'sato@zerobit.example', '2026-09-19 13:20+09');
SELECT pg_temp.install('ZB-2609-0118', 'MB',     pg_temp.buy('B850-ATX',         'MB24-0912',     'ドスパラ',     'DS-88120',     '2026-09-10', 24980),  'sato@zerobit.example', '2026-09-19 13:00+09');
SELECT pg_temp.install('ZB-2609-0118', 'MEMORY', pg_temp.buy('D5-5600-16X2',     'K5D-3308',      'パソコン工房', 'PK-55301',     '2026-09-11', 21980, 'B-15'), 'sato@zerobit.example', '2026-09-19 13:05+09');
SELECT pg_temp.install('ZB-2609-0118', 'SSD',    pg_temp.buy('NV4-1TB',          'S6Z-8820',      'パソコン工房', 'PK-55301',     '2026-09-11', 13980),  'sato@zerobit.example', '2026-09-19 13:07+09');
SELECT pg_temp.install('ZB-2609-0118', 'PSU',    pg_temp.buy('GD850',            'PS85-2216',     'ツクモ',       'TK-70012',     '2026-09-12', 16480, 'C-03'), 'sato@zerobit.example', '2026-09-19 13:30+09');
SELECT pg_temp.install('ZB-2609-0118', 'COOLER', pg_temp.buy('AIO240',           'LQ24-1180',     'Amazon',       'AMZ-503-1101', '2026-09-08', 11800),  'sato@zerobit.example', '2026-09-19 13:15+09');
SELECT pg_temp.install('ZB-2609-0118', 'CASE',   pg_temp.buy('MT-ATX',           NULL,            'Amazon',       'AMZ-503-1101', '2026-09-08', 9980),   'sato@zerobit.example', '2026-09-19 12:50+09');
SELECT pg_temp.install('ZB-2609-0118', 'OS',     pg_temp.buy('WIN11-HOME',       'KEY-QX7F',      'ソフト代理店', 'SW-2026-0915', '2026-09-15', 18500),  'sato@zerobit.example', '2026-09-19 13:45+09');

-- ZB-2609-0119（FBA倉庫に在庫中）
SELECT pg_temp.install('ZB-2609-0119', 'CPU',    pg_temp.buy('100-100001404WOF', '9MP3A7790',     'Amazon',       'AMZ-503-1101', '2026-09-08', 52800),  'sato@zerobit.example', '2026-09-19 16:10+09');
SELECT pg_temp.install('ZB-2609-0119', 'GPU',    pg_temp.buy('RTX5070-B12G',     'B5070-77120',   'ツクモ',       'TK-70012',     '2026-09-12', 97800, 'B-08'), 'sato@zerobit.example', '2026-09-19 16:20+09');
SELECT pg_temp.install('ZB-2609-0119', 'MB',     pg_temp.buy('B850-ATX',         'MB24-0913',     'ドスパラ',     'DS-88120',     '2026-09-10', 24980),  'sato@zerobit.example', '2026-09-19 16:00+09');
SELECT pg_temp.install('ZB-2609-0119', 'MEMORY', pg_temp.buy('D5-5600-16X2',     'K5D-3309',      'パソコン工房', 'PK-55301',     '2026-09-11', 21980, 'B-16'), 'sato@zerobit.example', '2026-09-19 16:05+09');
SELECT pg_temp.install('ZB-2609-0119', 'SSD',    pg_temp.buy('NV4-1TB',          'S6Z-8821',      'パソコン工房', 'PK-55301',     '2026-09-11', 13980),  'sato@zerobit.example', '2026-09-19 16:07+09');
SELECT pg_temp.install('ZB-2609-0119', 'PSU',    pg_temp.buy('GD850',            'PS85-2217',     'ツクモ',       'TK-70012',     '2026-09-12', 16480, 'C-04'), 'sato@zerobit.example', '2026-09-19 16:30+09');
SELECT pg_temp.install('ZB-2609-0119', 'COOLER', pg_temp.buy('AIO240',           'LQ24-1181',     'Amazon',       'AMZ-503-1101', '2026-09-08', 11800),  'sato@zerobit.example', '2026-09-19 16:15+09');
SELECT pg_temp.install('ZB-2609-0119', 'CASE',   pg_temp.buy('MT-ATX',           NULL,            'Amazon',       'AMZ-503-1101', '2026-09-08', 9980),   'sato@zerobit.example', '2026-09-19 15:50+09');
SELECT pg_temp.install('ZB-2609-0119', 'OS',     pg_temp.buy('WIN11-HOME',       'KEY-PL2M',      'ソフト代理店', 'SW-2026-0915', '2026-09-15', 18500),  'sato@zerobit.example', '2026-09-19 16:45+09');

-- ZB-2608-0077（RTX 5060 Ti 機）
SELECT pg_temp.install('ZB-2608-0077', 'CPU',    pg_temp.buy('100-100001405WOF', '9MP2B1045',     'Amazon',       'AMZ-501-0812', '2026-08-17', 36800),  'takahashi@zerobit.example', '2026-08-22 14:10+09');
SELECT pg_temp.install('ZB-2608-0077', 'GPU',    pg_temp.buy('RTX5060TI-A16G',   '602-V520-0077', 'ドスパラ',     'DS-87001',     '2026-08-17', 69800, 'B-02'), 'takahashi@zerobit.example', '2026-08-22 14:20+09');
SELECT pg_temp.install('ZB-2608-0077', 'MB',     pg_temp.buy('B850-ATX',         'MB24-0801',     'ドスパラ',     'DS-87001',     '2026-08-17', 24980),  'takahashi@zerobit.example', '2026-08-22 14:00+09');
SELECT pg_temp.install('ZB-2608-0077', 'MEMORY', pg_temp.buy('D5-5600-16X2',     'K5D-2201',      'パソコン工房', 'PK-54410',     '2026-08-18', 21980, 'B-03'), 'takahashi@zerobit.example', '2026-08-22 14:05+09');
SELECT pg_temp.install('ZB-2608-0077', 'SSD',    pg_temp.buy('NV4-1TB',          'S6Z-7710',      'パソコン工房', 'PK-54410',     '2026-08-18', 13980),  'takahashi@zerobit.example', '2026-08-22 14:07+09');
SELECT pg_temp.install('ZB-2608-0077', 'PSU',    pg_temp.buy('GD750',            'PS75-1102',     'ツクモ',       'TK-69120',     '2026-08-18', 13980, 'C-01'), 'takahashi@zerobit.example', '2026-08-22 14:30+09');
SELECT pg_temp.install('ZB-2608-0077', 'COOLER', pg_temp.buy('AIR120',           'AC12-0417',     'Amazon',       'AMZ-501-0812', '2026-08-17', 4980),   'takahashi@zerobit.example', '2026-08-22 14:15+09');
SELECT pg_temp.install('ZB-2608-0077', 'CASE',   pg_temp.buy('MT-ATX',           NULL,            'Amazon',       'AMZ-501-0812', '2026-08-17', 9980),   'takahashi@zerobit.example', '2026-08-22 13:50+09');
SELECT pg_temp.install('ZB-2608-0077', 'OS',     pg_temp.buy('WIN11-HOME',       'KEY-HT7A',      'ソフト代理店', 'SW-2026-0815', '2026-08-15', 18500),  'takahashi@zerobit.example', '2026-08-22 14:45+09');

-- ZB-2609-0102（GPUを初期不良で交換した例）
SELECT pg_temp.install('ZB-2609-0102', 'CPU',    pg_temp.buy('100-100001404WOF', '9MP3A7001',     'Amazon',       'AMZ-502-0901', '2026-09-01', 52800),  'sato@zerobit.example', '2026-09-08 15:10+09');
SELECT pg_temp.install('ZB-2609-0102', 'GPU',    pg_temp.buy('RTX5070-A12G',     '602-V531-3001', 'ドスパラ',     'DS-87950',     '2026-09-02', 98780, 'B-05'), 'sato@zerobit.example', '2026-09-08 15:20+09');
SELECT pg_temp.install('ZB-2609-0102', 'MB',     pg_temp.buy('B850-ATX',         'MB24-0901',     'ドスパラ',     'DS-87950',     '2026-09-02', 24980),  'sato@zerobit.example', '2026-09-08 15:00+09');
SELECT pg_temp.install('ZB-2609-0102', 'MEMORY', pg_temp.buy('D5-5600-16X2',     'K5D-3001',      'パソコン工房', 'PK-55020',     '2026-09-02', 21980, 'B-10'), 'sato@zerobit.example', '2026-09-08 15:05+09');
SELECT pg_temp.install('ZB-2609-0102', 'SSD',    pg_temp.buy('NV4-1TB',          'S6Z-8001',      'パソコン工房', 'PK-55020',     '2026-09-02', 13980),  'sato@zerobit.example', '2026-09-08 15:07+09');
SELECT pg_temp.install('ZB-2609-0102', 'PSU',    pg_temp.buy('GD850',            'PS85-2001',     'ツクモ',       'TK-69800',     '2026-09-03', 16480, 'C-02'), 'sato@zerobit.example', '2026-09-08 15:30+09');
SELECT pg_temp.install('ZB-2609-0102', 'COOLER', pg_temp.buy('AIO240',           'LQ24-1001',     'Amazon',       'AMZ-502-0901', '2026-09-01', 11800),  'sato@zerobit.example', '2026-09-08 15:15+09');
SELECT pg_temp.install('ZB-2609-0102', 'CASE',   pg_temp.buy('MT-ATX',           NULL,            'Amazon',       'AMZ-502-0901', '2026-09-01', 9980),   'sato@zerobit.example', '2026-09-08 14:50+09');
SELECT pg_temp.install('ZB-2609-0102', 'OS',     pg_temp.buy('WIN11-HOME',       'KEY-MM3C',      'ソフト代理店', 'SW-2026-0901', '2026-09-01', 18500),  'sato@zerobit.example', '2026-09-08 15:45+09');

-- 交換: 初期不良のGPUを外し、新しいGPUを付ける
UPDATE core.unit_parts
   SET removed_at = '2026-10-02 11:00+09', removed_by = pg_temp.usr('owner@zerobit.example'),
       remove_reason = '初期不良（画面にノイズ）。代理店へRMA'
 WHERE unit_id = pg_temp.unit('ZB-2609-0102') AND slot = 'GPU' AND removed_at IS NULL;
SELECT pg_temp.install('ZB-2609-0102', 'GPU',    pg_temp.buy('RTX5070-A12G',     '602-V531-3999', 'ドスパラ',     'DS-88400',     '2026-09-30', 98780, 'B-11'), 'owner@zerobit.example', '2026-10-02 11:20+09');

-- ZB-2610-0045（組立の途中。電源とOSがまだ。在庫の PS85-2301 と KEY-ZZ9P を読めば完成する）
SELECT pg_temp.install('ZB-2610-0045', 'CPU',    pg_temp.buy('100-100001404WOF', '9MP4C0451',     'Amazon',       'AMZ-504-1005', '2026-10-05', 52800),  'sato@zerobit.example', '2026-10-11 15:10+09');
SELECT pg_temp.install('ZB-2610-0045', 'GPU',    pg_temp.buy('RTX5070-A12G',     '602-V531-5045', 'ドスパラ',     'DS-89011',     '2026-10-06', 98780, 'B-12'), 'sato@zerobit.example', '2026-10-11 15:20+09');
SELECT pg_temp.install('ZB-2610-0045', 'MB',     pg_temp.buy('B850-ATX',         'MB24-1005',     'ドスパラ',     'DS-89011',     '2026-10-06', 24980),  'sato@zerobit.example', '2026-10-11 15:00+09');
SELECT pg_temp.install('ZB-2610-0045', 'MEMORY', pg_temp.buy('D5-5600-16X2',     'K5D-4045',      'パソコン工房', 'PK-56002',     '2026-10-06', 21980, 'B-17'), 'sato@zerobit.example', '2026-10-11 15:05+09');
SELECT pg_temp.install('ZB-2610-0045', 'SSD',    pg_temp.buy('NV4-1TB',          'S6Z-9045',      'パソコン工房', 'PK-56002',     '2026-10-06', 13980),  'sato@zerobit.example', '2026-10-11 15:07+09');
SELECT pg_temp.install('ZB-2610-0045', 'COOLER', pg_temp.buy('AIO240',           'LQ24-1450',     'Amazon',       'AMZ-504-1005', '2026-10-05', 11800),  'sato@zerobit.example', '2026-10-11 15:15+09');
SELECT pg_temp.install('ZB-2610-0045', 'CASE',   pg_temp.buy('MT-ATX',           NULL,            'Amazon',       'AMZ-504-1005', '2026-10-05', 9980),   'sato@zerobit.example', '2026-10-11 14:50+09');

-- 在庫の部品（まだどの個体にも付いていない）
SELECT pg_temp.buy('GD850',      'PS85-2301', 'ツクモ',       'TK-70550',     '2026-10-08', 16480, 'C-05');
SELECT pg_temp.buy('WIN11-HOME', 'KEY-ZZ9P',  'ソフト代理店', 'SW-2026-1001', '2026-10-01', 18500);

-- 新しく1台（ZB-G5070-R7）組み立てられる分の在庫。組立画面を試すのに使う
SELECT pg_temp.buy('100-100001404WOF', '9MP4C0501',     'Amazon',       'AMZ-505-1020', '2026-10-20', 52800);
SELECT pg_temp.buy('RTX5070-B12G',     'B5070-78001',   'ツクモ',       'TK-70901',     '2026-10-21', 97800, 'B-18');
SELECT pg_temp.buy('B850-ATX',         'MB24-1101',     'ドスパラ',     'DS-89500',     '2026-10-21', 24980);
SELECT pg_temp.buy('D5-5600-16X2',     'K5D-5101',      'パソコン工房', 'PK-56400',     '2026-10-21', 21980, 'B-19');
SELECT pg_temp.buy('NV4-1TB',          'S6Z-9501',      'パソコン工房', 'PK-56400',     '2026-10-21', 13980);
SELECT pg_temp.buy('GD850',            'PS85-2302',     'ツクモ',       'TK-70901',     '2026-10-21', 16480, 'C-06');
SELECT pg_temp.buy('AIO240',           'LQ24-1501',     'Amazon',       'AMZ-505-1020', '2026-10-20', 11800);
SELECT pg_temp.buy('MT-ATX',           NULL,            'Amazon',       'AMZ-505-1020', '2026-10-20', 9980);
SELECT pg_temp.buy('MT-ATX',           NULL,            'Amazon',       'AMZ-505-1020', '2026-10-20', 9980);
SELECT pg_temp.buy('WIN11-HOME',       'KEY-AB1C',      'ソフト代理店', 'SW-2026-1015', '2026-10-15', 18500);
-- 構成が違う部品（5070機に付けようとすると止まることを試す用）
SELECT pg_temp.buy('RTX5060TI-A16G',   '602-V520-0901', 'ドスパラ',     'DS-89500',     '2026-10-21', 69800, 'B-20');

-- シリアルのない部品はJANコードで読む（2で始まるのは店内用の番号。ダミー）
UPDATE core.part_models SET jan_code = '2000000000015' WHERE model_no = 'MT-ATX';
-- シリアルのある部品にもJANはある。JANを読んだら「シリアルを読んで」と案内する
UPDATE core.part_models SET jan_code = '2000000000022' WHERE model_no = 'GD850';

-- ---------- 検品 ----------
-- 出荷済みなどの個体の、過去の検品（3段階）。今の決まり（検品中の個体だけ記録できる）を通さずに入れるため、
-- この部分だけトリガーを止める（開発用のダミーデータだけ。監査ログにも残らない）
SET LOCAL session_replication_role = replica;
INSERT INTO core.inspections (unit_id, inspector_id, stage, started_at, finished_at, stress_test_minutes,
                              max_cpu_temp_c, max_gpu_temp_c, noise_db, checklist, benchmarks, result)
SELECT pg_temp.unit(v.mgmt_no), pg_temp.usr('owner@zerobit.example'), st.stage,
       v.day + st.start_at, v.day + st.end_at,
       CASE WHEN st.stage = 'software' THEN 120 END,
       CASE WHEN st.stage = 'software' THEN v.cpu END,
       CASE WHEN st.stage = 'software' THEN v.gpu END,
       CASE WHEN st.stage = 'software' THEN v.noise END,
       st.checklist,
       CASE WHEN st.stage = 'software'
            THEN jsonb_build_array(jsonb_build_object('name', 'Cinebench R23 マルチ', 'score', v.cb),
                                   jsonb_build_object('name', '3DMark Time Spy', 'score', v.ts))
            ELSE '[]'::jsonb END,
       'pass'
FROM (VALUES
  ('ZB-2608-0077', timestamptz '2026-08-23 00:00+09', 74.0, 66.5, 36.5, 15200, 11800),
  ('ZB-2609-0102', timestamptz '2026-09-09 00:00+09', 77.0, 70.0, 37.5, 19100, 17400),
  ('ZB-2609-0118', timestamptz '2026-09-20 00:00+09', 78.5, 71.0, 38.0, 19000, 17300),
  ('ZB-2609-0119', timestamptz '2026-09-20 00:00+09', 77.5, 69.5, 37.0, 19200, 17500)
) AS v(mgmt_no, day, cpu, gpu, noise, cb, ts)
CROSS JOIN (VALUES
  ('assembled', interval '8 hours',  interval '8 hours 20 minutes',
   '{"配線の取り回し（ファンに当たらない・まとめてある）":true,"電源・PCIe・フロントパネルのコネクタがしっかり刺さっている":true,"内部の傷・汚れ・ネジの締め忘れがない":true,"ファンの向きと回転（仮に電源を入れて確認）":true}'::jsonb),
  ('software',  interval '8 hours 30 minutes', interval '10 hours 40 minutes',
   '{"BIOS の更新と設定（XMP/EXPO など）":true,"Windows のインストール":true,"Windows のライセンス認証":true,"Windows Update とドライバー":true,"メモリテストでエラーなし":true,"SSD の健康状態が正常（CrystalDiskInfo など）":true,"USB 端子（前面・背面）":true,"音声の出力":true,"有線 LAN":true,"Wi-Fi・Bluetooth":"na"}'::jsonb),
  ('final',     interval '10 hours 45 minutes', interval '11 hours',
   '{"外観（傷・汚れ・指紋）":true,"付属品（説明書・電源ケーブル・保証書）":true,"管理番号シール（本体と箱）":true,"起動して画面が映る（出荷直前）":true,"梱包（緩衝材・固定）":true}'::jsonb)
) AS st(stage, start_at, end_at, checklist);
SET LOCAL session_replication_role = origin;

-- ---------- 顧客（番号だけ。個人情報は入れない）と注文 ----------
INSERT INTO core.customers (is_corporate) VALUES (false), (false), (false);

INSERT INTO core.orders (channel, external_order_no, is_fba, ordered_at, delivered_at, total_amount, status, customer_id) VALUES
  ('amazon', '250-1100223-0000077', true, '2026-08-26 21:10+09', '2026-08-27 18:00+09', 239800, 'delivered', 2),
  ('amazon', '250-5550101-0000102', true, '2026-09-12 09:30+09', '2026-09-13 17:00+09', 349800, 'delivered', 3),
  ('amazon', '250-7712045-0003390', true, '2026-09-23 20:45+09', '2026-09-24 19:00+09', 349800, 'delivered', 1);

INSERT INTO core.order_lines (order_id, sku_id, description, qty, unit_price)
SELECT o.id, pg_temp.sku(v.sku), v.sku, 1, o.total_amount
FROM (VALUES ('250-1100223-0000077','ZB-G5060-R5'), ('250-5550101-0000102','ZB-G5070-R7'),
             ('250-7712045-0003390','ZB-G5070-R7')) AS v(order_no, sku)
JOIN core.orders o ON o.external_order_no = v.order_no;

-- FBA注文と個体の紐づけ（製品登録と、問い合わせで管理番号を聞いたとき）
INSERT INTO core.order_units (order_id, unit_id, link_method, linked_at)
SELECT o.id, pg_temp.unit(v.mgmt_no), v.method, v.at::timestamptz
FROM (VALUES ('250-7712045-0003390','ZB-2609-0118','product_registration','2026-09-25 10:00+09'),
             ('250-1100223-0000077','ZB-2608-0077','support',             '2026-10-12 16:40+09'),
             ('250-5550101-0000102','ZB-2609-0102','support',             '2026-10-01 14:00+09')) AS v(order_no, mgmt_no, method, at)
JOIN core.orders o ON o.external_order_no = v.order_no;

INSERT INTO core.product_registrations (unit_id, customer_id, order_id, registered_at, verification)
SELECT pg_temp.unit('ZB-2609-0118'), 1, o.id, '2026-09-25 10:00+09', 'verified'
FROM core.orders o WHERE o.external_order_no = '250-7712045-0003390';

-- ---------- 修理・RMA ----------
INSERT INTO core.repair_tickets (unit_id, symptom, coverage, status, received_at, returned_at, note) VALUES
  (pg_temp.unit('ZB-2609-0102'), '画面にノイズが出る', 'warranty', 'returned',
   '2026-10-01 14:00+09', '2026-10-04 15:00+09', 'GPUを交換して返送'),
  (pg_temp.unit('ZB-2609-0118'), '電源が入らない。ファンも回らない', 'warranty', 'received',
   '2026-10-12 17:30+09', NULL, '電源ユニットの不具合の可能性');

INSERT INTO core.rma_cases (part_item_id, supplier_id, repair_ticket_id, rma_no, reason, status, sent_at)
SELECT p.id, (SELECT id FROM core.suppliers WHERE name = 'GPU代理店A'),
       (SELECT id FROM core.repair_tickets WHERE unit_id = pg_temp.unit('ZB-2609-0102')),
       'RMA-24-1188', '画面にノイズ（初期不良）', 'sent', '2026-10-03 10:00+09'
FROM core.part_items p WHERE p.serial_no = '602-V531-3001';
UPDATE core.part_items SET status = 'in_rma' WHERE serial_no = '602-V531-3001';

COMMIT;
