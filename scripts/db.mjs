#!/usr/bin/env node
// 開発用データベースの操作（Windows / Mac / Linux 共通）
//
//   npm run db:up     … Docker で PostgreSQL を起動する
//   npm run db:reset  … 開発用DB（zerobit）を作り直し、マイグレーションを流す（データは空）
//   npm run db:seed   … db:reset のあと、ダミーデータ（db/seeds/）を入れる
//   npm run db:test   … テスト用DB（zerobit_test）を作り直し、マイグレーションとDBのテストを流す
//   npm run test      … 画面側のテスト。アプリ用のテストDB（zerobit_apptest）を作り直してから流す
//   npm run db:psql   … 開発用DBに psql でつなぐ
//
// db:reset / db:seed は、アプリが使う接続先を app/.env.local の DATABASE_URL に書き込む。
// アプリは個人情報を読めない DB ロール zb_app で接続する（CLAUDE.md ルール2）。
//
// 既定では Docker のコンテナ（docker-compose.yml の db）の中の psql を使う。
// Docker を使わず手元の psql を使うときは ZB_DB_MODE=local を付ける
// （接続先は PGHOST / PGPORT / PGUSER / PGPASSWORD で指定）。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const mode = process.env.ZB_DB_MODE === 'local' ? 'local' : 'docker';
const DEV_DB = 'zerobit';
const TEST_DB = 'zerobit_test';
const APP_TEST_DB = 'zerobit_apptest';
// 開発用だけで使う zb_app のパスワード。自分のパソコンの中でしか使わない
const APP_PASSWORD = process.env.ZB_APP_PASSWORD || 'zb-app-local-only';

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(cmd, args, { capture = false, env, cwd = root } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: env ?? process.env,
    shell: process.platform === 'win32' && cmd === 'npx',
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      fail(cmd === 'docker'
        ? 'docker が見つかりません。Docker Desktop を起動してから、もう一度実行してください。'
        : `${cmd} が見つかりません。`);
    }
    fail(r.error.message);
  }
  return r;
}

// PostgreSQL のツール（psql, createdb, dropdb）を管理者（postgres）で実行する
function pg(tool, args, opts) {
  if (mode === 'docker') {
    return run('docker', ['compose', 'exec', '-T', 'db', tool, '-U', 'postgres', ...args], opts);
  }
  return run(tool, args, opts);
}

// SQLファイルの場所（Docker ではコンテナに /db として見せている）
function sqlPath(file) {
  if (mode === 'docker') {
    return '/db/' + relative(join(root, 'db'), file).split(sep).join('/');
  }
  return file;
}

function sqlFiles(subdir) {
  const dir = join(root, 'db', subdir);
  if (!existsSync(dir)) return [];
  const pattern = subdir === 'migrations' ? /^\d{4}_.+\.sql$/ : /\.sql$/;
  return readdirSync(dir).filter((f) => pattern.test(f)).sort().map((f) => join(dir, f));
}

function psqlFile(db, file, { quiet = false } = {}) {
  const name = relative(root, file);
  console.log(`→ ${name}`);
  // quiet: SELECT の結果表は出さない（エラーと注意は出る）
  const r = pg('psql', ['-d', db, '-v', 'ON_ERROR_STOP=1', '-q', ...(quiet ? ['-o', '/dev/null'] : []),
                        '-f', sqlPath(file)]);
  if (r.status !== 0) fail(`${name} でエラーになりました。`);
}

function psqlCommand(db, sql) {
  const r = pg('psql', ['-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { capture: true });
  if (r.status !== 0) fail(`SQLの実行に失敗しました: ${r.stderr}`);
}

function recreate(db) {
  let r = pg('dropdb', ['--if-exists', '--force', db]);
  if (r.status !== 0) fail(`${db} を削除できませんでした。`);
  r = pg('createdb', [db]);
  if (r.status !== 0) fail(`${db} を作成できませんでした。`);
}

// DBを作り直し、マイグレーション（と必要ならダミーデータ）を流して、zb_app で入れるようにする
function prepare(db, { seed }) {
  recreate(db);
  for (const f of sqlFiles('migrations')) psqlFile(db, f);
  if (seed) for (const f of sqlFiles('seeds')) psqlFile(db, f, { quiet: true });
  const quoted = APP_PASSWORD.replaceAll("'", "''");
  psqlCommand(db, `ALTER ROLE zb_app PASSWORD '${quoted}'`);
}

// アプリ（zb_app）がつなぐ接続文字列
function appUrl(db) {
  const user = `zb_app:${encodeURIComponent(APP_PASSWORD)}`;
  if (mode === 'local' && process.env.PGHOST?.startsWith('/')) {
    return `postgres://${user}@localhost/${db}?host=${encodeURIComponent(process.env.PGHOST)}`;
  }
  const host = mode === 'local' ? (process.env.PGHOST || 'localhost') : 'localhost';
  const port = mode === 'local' ? (process.env.PGPORT || '5432') : '5432';
  return `postgres://${user}@${host}:${port}/${db}`;
}

// app/.env.local の DATABASE_URL だけを書き換える（ほかの行は残す）
function writeAppEnv(db) {
  const file = join(root, 'app', '.env.local');
  const line = `DATABASE_URL=${appUrl(db)}`;
  const lines = existsSync(file)
    ? readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('DATABASE_URL='))
    : ['# 開発用。npm run db:reset / db:seed が DATABASE_URL を書き換える（git に入らない）'];
  writeFileSync(file, [...lines, line, ''].join('\n'));
  console.log(`→ app/.env.local の DATABASE_URL を ${db} に向けました`);
}

const command = process.argv[2];

switch (command) {
  case 'up': {
    const r = run('docker', ['compose', 'up', '-d', '--wait']);
    if (r.status !== 0) fail('PostgreSQL を起動できませんでした。.env があるか、Docker Desktop が起動しているか確認してください。');
    console.log('\n✓ PostgreSQL が起動しました（localhost:5432）');
    break;
  }
  case 'reset':
  case 'seed': {
    prepare(DEV_DB, { seed: command === 'seed' });
    writeAppEnv(DEV_DB);
    console.log(`\n✓ ${DEV_DB} を作り直しました${command === 'seed' ? '（ダミーデータ入り）' : ''}`);
    break;
  }
  case 'test': {
    prepare(TEST_DB, { seed: false });
    console.log('→ db/tests/schema_test.sql');
    const r = pg('psql', ['-d', TEST_DB, '-v', 'ON_ERROR_STOP=1', '-q',
                          '-f', sqlPath(join(root, 'db', 'tests', 'schema_test.sql'))], { capture: true });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const passed = (out.match(/NOTICE:\s+OK/g) ?? []).length;
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/(NOTICE|ERROR):\s+(.*)$/);
      if (m) console.log(m[1] === 'ERROR' ? `  ✗ ${m[2]}` : `  ・${m[2]}`);
    }
    if (r.status !== 0 || !out.includes('ALL TESTS PASSED')) {
      fail(`テストが失敗しました（${passed}項目まで通過）。上の ✗ の行を確認してください。`);
    }
    console.log(`\n✓ ALL TESTS PASSED（${passed}項目）`);
    break;
  }
  case 'app-test': {
    prepare(APP_TEST_DB, { seed: true });
    console.log('→ app のテスト（vitest）');
    const r = run('npx', ['vitest', 'run'], {
      cwd: join(root, 'app'),
      env: { ...process.env, DATABASE_URL: appUrl(APP_TEST_DB) },
    });
    process.exit(r.status ?? 1);
  }
  case 'psql': {
    const r = pg('psql', ['-d', DEV_DB]);
    process.exit(r.status ?? 0);
  }
  default:
    console.log('使い方: node scripts/db.mjs up | reset | seed | test | app-test | psql');
    process.exit(command ? 1 : 0);
}
