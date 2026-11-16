#!/usr/bin/env bash
# =====================================================================
# 毎月の復元の試験（仕様書8章）。代表が Cloud Shell で動かす（10分ほど）
#
#   bash restore-test.sh prod zerobit-prod                 … 大阪のいちばん新しいバックアップで試す
#   bash restore-test.sh prod zerobit-prod db/hourly/2026/12/01/000709.dump.age   … 決めたもので試す
#
# してること：
#   1. 大阪のバケットからバックアップ（.dump.age）と控え（.json）を落とし、ハッシュが控えと合うか確かめる
#   2. 復号の鍵を貼ってもらい（画面に出ない）、復号する。鍵とファイルはメモリの上（/dev/shm）にだけ置き、終わったら消す
#   3. 同じ Cloud SQL の中に一時的なデータベース（zerobit_restore_test_日時）を作って戻す
#      （本物のデータを検証環境に入れないため、戻す先は検証ではなく、同じプロジェクトの中の一時的なデータベース）
#   4. 表ごとの行数が控えと合うかを比べる
#   5. 結果を core.integration_runs（kind = restore_test）に残す（ホームの「今月の復元の試験」の知らせが消える）
#   6. 一時的なデータベースを消す（途中で止まっても、終わるときに必ず消す）
# =====================================================================
set -euo pipefail

SQL_INSTANCE=zerobit-db
MAIN_DB=zerobit
PROXY_PORT=6543
PROXY_VERSION=v2.11.0

say()  { printf '\n\033[1m→ %s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
fail() { printf '\n  ✗ %s\n' "$*" >&2; exit 1; }

# ---------- 部品（手元のテストでも使う） ----------

# バックアップのハッシュを控えと比べ、鍵で復号して、中身の一覧が出るか確かめる
#   decrypt_backup <.dump.age> <.json> <鍵のファイル> <書き出し先>
decrypt_backup() {
  local enc="$1" manifest="$2" key="$3" out="$4" want got
  want=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$manifest")
  got=$(sha256sum "$enc" | cut -d' ' -f1)
  [[ "$want" == "$got" ]] || fail "バックアップのハッシュが控えと合いません（壊れているか、別のファイルです）"
  age --decrypt -i "$key" -o "$out" "$enc" 2>/dev/null || fail "復号できません。鍵が違う（stg と prod を取り違えていないか）か、ファイルが壊れています"
  pg_restore --list "$out" >/dev/null || fail "復号はできましたが、中身を読めません"
}

# 戻して、表ごとの行数を控えと比べる。接続先は PGHOST・PGPORT・PGUSER・PGPASSWORD
#   restore_and_count <db.dump> <.json> <戻す先のデータベース>
#   結果：RESULT_OK（true/false）・RESULT_SUMMARY（JSON）・RESULT_ERROR
restore_and_count() {
  local dump="$1" manifest="$2" db="$3" sql counts
  RESULT_OK=false RESULT_ERROR="" RESULT_SUMMARY="{}"
  if ! pg_restore --no-owner --no-acl --exit-on-error -d "$db" "$dump" 2>"$WORK/restore.err"; then
    RESULT_ERROR="pg_restore が失敗しました：$(tail -c 200 "$WORK/restore.err" | tr '\n' ' ')"
    RESULT_SUMMARY=$(python3 -c 'import json,sys; print(json.dumps({"object": sys.argv[1]}))' "$OBJECT_NAME")
    return 0
  fi
  # 控えにある表ごとに数える（1回の問い合わせで）
  sql=$(python3 - "$manifest" <<'PY'
import json, sys
tables = json.load(open(sys.argv[1]))["tables"]
q = lambda s: '"' + s.replace('"', '""') + '"'
parts = []
for name in sorted(tables):
    schema, table = name.split(".", 1)
    parts.append(f"SELECT '{name}', count(*) FROM {q(schema)}.{q(table)}")
print(" UNION ALL ".join(parts) + ";")
PY
)
  if ! counts=$(psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -d "$db" -c "$sql" 2>"$WORK/count.err"); then
    RESULT_ERROR="行数を数えられません（表が足りない）：$(tail -c 200 "$WORK/count.err" | tr '\n' ' ')"
    RESULT_SUMMARY=$(python3 -c 'import json,sys; print(json.dumps({"object": sys.argv[1]}))' "$OBJECT_NAME")
    return 0
  fi
  RESULT_SUMMARY=$(python3 - "$manifest" "$OBJECT_NAME" "$counts" <<'PY'
import json, sys
tables = json.load(open(sys.argv[1]))["tables"]
got = {}
for line in sys.argv[3].splitlines():
    if line.strip():
        name, n = line.rsplit("|", 1)
        got[name] = int(n)
mismatches = sorted(t for t in tables if got.get(t) != tables[t])
print(json.dumps({"object": sys.argv[2], "tables": len(tables), "rows": sum(tables.values()), "mismatches": mismatches}, ensure_ascii=False))
PY
)
  if [[ $(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])["mismatches"]))' "$RESULT_SUMMARY") == 0 ]]; then
    RESULT_OK=true
  else
    RESULT_ERROR="行数が控えと合わない表があります"
  fi
}

# 結果を残す（本体のデータベースに。監査ログのため実行者を設定する：ルール7）
#   record_result <本体のデータベース>
record_result() {
  psql -X -q -v ON_ERROR_STOP=1 -d "$1" -v ok="$RESULT_OK" -v summary="$RESULT_SUMMARY" -v err="${RESULT_ERROR:0:300}" <<'SQL' >/dev/null
BEGIN;
SET LOCAL app.actor_kind = 'system';
INSERT INTO core.integration_runs (kind, mode, finished_at, ok, summary, error)
VALUES ('restore_test', 'manual', now(), :'ok'::boolean, :'summary'::jsonb, nullif(:'err', ''));
COMMIT;
SQL
}

# ---------- 本体（Cloud Shell） ----------

need_tools() {
  local missing=()
  command -v age >/dev/null || missing+=(age)
  if ! pg_restore --version 2>/dev/null | grep -qE ' (1[6-9]|[2-9][0-9])\.'; then missing+=(postgresql-client-16); fi
  if (( ${#missing[@]} )); then
    say "道具を入れる（${missing[*]}。Cloud Shell は入れたものが次の回には消えるので、毎回入れる）"
    if [[ " ${missing[*]} " == *" postgresql-client-16 "* ]]; then
      sudo install -d /usr/share/postgresql-common/pgdg
      sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
      # shellcheck disable=SC1091
      . /etc/os-release
      echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" |
        sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
    fi
    sudo apt-get update -qq >/dev/null
    sudo apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
    [[ -x /usr/lib/postgresql/16/bin/pg_restore ]] && export PATH="/usr/lib/postgresql/16/bin:$PATH"
    ok "入れました"
  fi
  if command -v cloud-sql-proxy >/dev/null; then
    PROXY=cloud-sql-proxy
  else
    PROXY="$WORK/cloud-sql-proxy"
    curl -fsSL -o "$PROXY" "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${PROXY_VERSION}/cloud-sql-proxy.linux.amd64"
    chmod +x "$PROXY"
  fi
}

cleanup() {
  local code=$?
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null && wait "$PROXY_PID" 2>/dev/null
  if [[ -n "${TEST_DB_CREATED:-}" ]]; then
    gcloud sql databases delete "$TEST_DB" --instance="$SQL_INSTANCE" --project="$PROJECT" --quiet >/dev/null 2>&1 &&
      echo "  ✓ 一時的なデータベース ${TEST_DB} を消しました" ||
      echo "  ✗ 一時的なデータベース ${TEST_DB} を消せませんでした。Cloud SQL の画面の「データベース」から消してください"
  fi
  if [[ -n "${WORK:-}" && -d "$WORK" ]]; then
    find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true
    rm -rf "$WORK"
  fi
  exit "$code"
}

main() {
  ENV_NAME="${1:-}"; PROJECT="${2:-}"; OBJECT_NAME="${3:-}"
  if [[ ! "$ENV_NAME" =~ ^(stg|prod)$ || -z "$PROJECT" ]]; then
    echo "使い方：bash restore-test.sh stg|prod <プロジェクトID> [db/hourly/…/時分秒.dump.age]"; exit 1
  fi
  BACKUP_BUCKET="${PROJECT}-backup"
  TEST_DB="zerobit_restore_test_$(date +%Y%m%d%H%M%S)"
  WORK=$(mktemp -d -p /dev/shm 2>/dev/null || mktemp -d)
  chmod 700 "$WORK"
  umask 077
  trap cleanup EXIT
  gcloud config set project "$PROJECT" >/dev/null 2>&1

  need_tools

  say "大阪のバックアップを選ぶ"
  if [[ -z "$OBJECT_NAME" ]]; then
    OBJECT_NAME=$(gcloud storage ls "gs://${BACKUP_BUCKET}/db/hourly/**.dump.age" | sort | tail -1 | sed "s#^gs://${BACKUP_BUCKET}/##")
    [[ -n "$OBJECT_NAME" ]] || fail "gs://${BACKUP_BUCKET}/db/hourly/ にバックアップがありません"
  fi
  local manifest_name="${OBJECT_NAME%.dump.age}.json"
  gcloud storage cp "gs://${BACKUP_BUCKET}/${OBJECT_NAME}" "$WORK/db.dump.age" --quiet
  gcloud storage cp "gs://${BACKUP_BUCKET}/${manifest_name}" "$WORK/manifest.json" --quiet
  ok "$OBJECT_NAME"

  say "復号する"
  local key=""
  read -r -s -p "  復号の鍵（AGE-SECRET-KEY-1…。パスワード管理ツールの「ZERO-BIT バックアップの鍵（${ENV_NAME}）」）を貼ってください（画面に出ません）： " key; echo
  [[ "$key" == AGE-SECRET-KEY-1* ]] || fail "鍵の形が違います（AGE-SECRET-KEY-1 で始まるもの）"
  printf '%s\n' "$key" > "$WORK/key.txt"; key=""
  decrypt_backup "$WORK/db.dump.age" "$WORK/manifest.json" "$WORK/key.txt" "$WORK/db.dump"
  shred -u "$WORK/key.txt"
  ok "ハッシュが控えと合い、鍵で戻せて、中身の一覧が読めました"

  say "一時的なデータベースに戻す（${TEST_DB}）"
  local conn admin_url
  conn=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')
  admin_url=$(gcloud secrets versions access latest --secret=db-admin-url)
  PGPASSWORD=$(python3 -c 'import sys,urllib.parse as u; print(u.unquote(u.urlsplit(sys.argv[1]).password or ""))' "$admin_url")
  export PGPASSWORD PGHOST=127.0.0.1 PGPORT="$PROXY_PORT" PGUSER=postgres
  admin_url=""
  gcloud sql databases create "$TEST_DB" --instance="$SQL_INSTANCE" >/dev/null
  TEST_DB_CREATED=1
  "$PROXY" --port "$PROXY_PORT" --token "$(gcloud auth print-access-token)" "$conn" >"$WORK/proxy.log" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
  pg_isready -q || fail "データベースにつながりません（$(tail -c 200 "$WORK/proxy.log")）"
  restore_and_count "$WORK/db.dump" "$WORK/manifest.json" "$TEST_DB"

  say "結果を残す"
  record_result "$MAIN_DB"
  if [[ "$RESULT_OK" == true ]]; then
    ok "合格：表 $(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["tables"])' "$RESULT_SUMMARY") 個の行数がすべて控えと合いました"
  else
    printf '  ✗ 不合格：%s\n  %s\n' "$RESULT_ERROR" "$RESULT_SUMMARY"
  fi
  say "片付け"
  [[ "$RESULT_OK" == true ]]
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
