#!/usr/bin/env node
// 開発用データベースの操作（Windows / Mac / Linux 共通）
//
//   npm run db:up     … Docker で PostgreSQL を起動する
//   npm run db:reset  … 開発用DB（zerobit）を作り直し、マイグレーションを全部流す
//   npm run db:test   … テスト用DB（zerobit_test）を作り直し、マイグレーションとテストを流す
//   npm run db:psql   … 開発用DBに psql でつなぐ
//
// 既定では Docker のコンテナ（docker-compose.yml の db）の中の psql を使う。
// Docker を使わず手元の psql を使うときは ZB_DB_MODE=local を付ける
// （接続先は PGHOST / PGPORT / PGUSER / PGPASSWORD で指定）。

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.env.ZB_DB_MODE === 'local' ? 'local' : 'docker';
const DEV_DB = 'zerobit';
const TEST_DB = 'zerobit_test';

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
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

// PostgreSQL のツール（psql, createdb, dropdb）を実行する
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

function migrations() {
  const dir = join(root, 'db', 'migrations');
  return readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => join(dir, f));
}

function recreate(db) {
  let r = pg('dropdb', ['--if-exists', '--force', db]);
  if (r.status !== 0) fail(`${db} を削除できませんでした。`);
  r = pg('createdb', [db]);
  if (r.status !== 0) fail(`${db} を作成できませんでした。`);
}

function applyMigrations(db) {
  for (const file of migrations()) {
    const name = relative(root, file);
    console.log(`→ ${name}`);
    const r = pg('psql', ['-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-f', sqlPath(file)]);
    if (r.status !== 0) fail(`${name} でエラーになりました。`);
  }
}

const command = process.argv[2];

switch (command) {
  case 'up': {
    const r = run('docker', ['compose', 'up', '-d', '--wait']);
    if (r.status !== 0) fail('PostgreSQL を起動できませんでした。.env があるか、Docker Desktop が起動しているか確認してください。');
    console.log('\n✓ PostgreSQL が起動しました（localhost:5432）');
    break;
  }
  case 'reset': {
    recreate(DEV_DB);
    applyMigrations(DEV_DB);
    console.log(`\n✓ ${DEV_DB} を作り直し、マイグレーションを流しました`);
    break;
  }
  case 'test': {
    recreate(TEST_DB);
    applyMigrations(TEST_DB);
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
  case 'psql': {
    const r = pg('psql', ['-d', DEV_DB]);
    process.exit(r.status ?? 0);
  }
  default:
    console.log('使い方: node scripts/db.mjs up | reset | test | psql');
    process.exit(command ? 1 : 0);
}
