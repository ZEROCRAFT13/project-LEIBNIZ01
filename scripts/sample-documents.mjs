// 書類の取り込みを試すための、ダミーの書類（PDF）を取り込みフォルダに置く。
//   npm run docs:samples
// 中身はすべて作り物（ダミーデータの仕入れの注文番号に合わせてある）。本物の領収書は使わない（ルール1）。

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inbox = process.env.ZB_INBOX_DIR || join(root, 'inbox');

function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 12 Tf', '14 TL', '50 780 Td',
    ...lines.map((l, i) => (i === 0 ? `(${esc(l)}) Tj` : `T* (${esc(l)}) Tj`)), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const samples = [
  [`領収書_ドスパラ_DS-88120.pdf`, ['DUMMY RECEIPT (sample)', 'Shop: Dospara (dummy)', 'Order No. DS-88120',
    'Date 2026-09-10', 'Total 123,760 JPY', 'Registration No. T1234567890123', `id ${stamp}`]],
  [`scan_${stamp}.pdf`, ['DELIVERY NOTE (sample)', 'Order No. PK-55301', 'DDR5-5600 32GB x1', `id ${stamp}`]],
  [`保証書_サンプル_${stamp}.pdf`, ['WARRANTY CARD (sample)', 'Serial 602-V531-4471', `id ${stamp}`]],
];

mkdirSync(inbox, { recursive: true });
const old = new Date(Date.now() - 60_000); // 「書き込み中」と見なされないよう、少し前の時刻にする
for (const [name, lines] of samples) {
  const path = join(inbox, name);
  writeFileSync(path, makePdf(lines));
  utimesSync(path, old, old);
  console.log(`→ ${path}`);
}
console.log('\n✓ ダミーの書類を置きました。画面の「書類」→「取り込みフォルダから取り込む」で取り込めます。');
