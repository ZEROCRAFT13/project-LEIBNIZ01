// 本番・検証のデータベースに、最初の代表（owner）を1人だけ登録する（はじめて使うときに1回）。
//   node scripts/bootstrap-owner.mjs <Google のメールアドレス> <表示名>
// 代表がもういれば何もしない（2人目以降は画面から足す）。組立担当以外の役割をすべて付ける。
// 接続先は DATABASE_URL_ADMIN（Cloud Run のジョブで、マイグレーションと同じ設定で動かす）
import pg from 'pg';

const [email, name] = process.argv.slice(2).map((s) => (s ?? '').trim());
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '') || !name) {
  console.error('使い方：node scripts/bootstrap-owner.mjs <メールアドレス> <表示名>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.actor_kind', 'system', true)");
  const owners = await client.query("SELECT count(*)::int AS n FROM core.users WHERE kind = 'owner'");
  if (owners.rows[0].n > 0) {
    console.log('✓ 代表はもう登録されています（何もしませんでした）');
    await client.query('ROLLBACK');
  } else {
    const u = await client.query(
      "INSERT INTO core.users (email, display_name, kind) VALUES ($1, $2, 'owner') RETURNING id",
      [email.toLowerCase(), name],
    );
    await client.query(
      "INSERT INTO core.role_assignments (role_code, user_id) SELECT code, $1 FROM core.roles WHERE code <> 'assembler'",
      [u.rows[0].id],
    );
    await client.query('COMMIT');
    console.log('✓ 代表を登録しました（組立担当以外のすべての役割）');
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
