#!/usr/bin/env bash
# =====================================================================
# Google Cloud に ZERO-BIT の検証環境・本番環境を用意する（Cloud Shell で、環境ごとに1回動かす）
#
#   bash infra/setup.sh stg  <プロジェクトID> <ドメイン>     例：bash infra/setup.sh stg  zerobit-stg  stg.example.jp
#   bash infra/setup.sh prod <プロジェクトID> <ドメイン>     例：bash infra/setup.sh prod zerobit-prod app.example.jp
#
# 何度動かしても大丈夫（あるものは作り直さない）。途中で止まったら、直してからもう一度動かす。
# キー（SP-API・Google ログイン）は、ここで聞かれたときに直接打ち込む（画面に出ない。チャットには貼らない）。
# 作るもの：
#   Cloud SQL（PostgreSQL 16・東京・自動バックアップと任意の時点に戻す設定）、Cloud Storage（書類・写真）、
#   Secret Manager（キーとパスワード）、Artifact Registry（コンテナ）、サービスアカウント、
#   GitHub Actions から鍵なしで反映するための設定（Workload Identity）、
#   独自ドメインのためのロードバランサ（HTTPS の証明書は Google が自動で出す）、Cloud Scheduler（5分ごとの注文の取り込み）、
#   データベースのバックアップ（大阪のバケット・暗号化の鍵・1時間ごとに動かす設定。仕様書8章）
# Cloud Run のサービス（画面）とジョブ（マイグレーション・バックアップ）は、GitHub Actions が反映のときに作る。
# 前に動かした環境でも、もう一度動かせば足りないもの（バックアップなど）だけを足す。
# =====================================================================
set -euo pipefail

ENV_NAME="${1:-}"; PROJECT="${2:-}"; DOMAIN="${3:-}"
if [[ ! "$ENV_NAME" =~ ^(stg|prod)$ || -z "$PROJECT" || -z "$DOMAIN" ]]; then
  echo "使い方：bash infra/setup.sh stg|prod <プロジェクトID> <ドメイン>"; exit 1
fi
REGION=asia-northeast1
BACKUP_REGION=asia-northeast2   # 大阪（東京が止まっても残るように）
GITHUB_REPO="${GITHUB_REPO:-ZEROCRAFT13/project-LEIBNIZ01}"
SQL_INSTANCE=zerobit-db
DB_NAME=zerobit
SERVICE=zerobit
BUCKET="${PROJECT}-files"
BACKUP_BUCKET="${PROJECT}-backup"
RUN_SA="zb-run@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA="zb-deploy@${PROJECT}.iam.gserviceaccount.com"
MIGRATE_SA="zb-migrate@${PROJECT}.iam.gserviceaccount.com"   # マイグレーションだけ（管理者のパスワードを読めるのはこれだけ）
BACKUP_SA="zb-backup@${PROJECT}.iam.gserviceaccount.com"     # バックアップだけ（DB は読むだけ。置き場所には足すだけで、消せない）

if [[ "$ENV_NAME" == prod ]]; then
  SQL_TIER=db-custom-1-3840; BACKUPS_KEPT=30; LOG_DAYS=7
  # 大阪のバックアップを残す日数（1時間ごと・日・月・年）と、消せない期間
  KEEP_HOURLY=15; KEEP_DAILY=91; KEEP_MONTHLY=400; KEEP_YEARLY=3700; BACKUP_LOCK=14d
else
  SQL_TIER=db-f1-micro;      BACKUPS_KEPT=7;  LOG_DAYS=3
  KEEP_HOURLY=3;  KEEP_DAILY=14; KEEP_MONTHLY=60;  KEEP_YEARLY=400;  BACKUP_LOCK=1d
fi

say() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }

gcloud config set project "$PROJECT" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

say "使う機能（API）を有効にする（数分かかることがある）"
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com compute.googleapis.com storage.googleapis.com
ok "有効にしました"

say "コンテナの置き場所（Artifact Registry）"
gcloud artifacts repositories describe zerobit --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create zerobit --repository-format=docker --location="$REGION" --description="ZERO-BIT"
ok "asia-northeast1/zerobit"

say "サービスアカウント（画面が動くとき用・GitHub から反映するとき用）"
gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create zb-run --display-name="ZERO-BIT 画面（Cloud Run）"
gcloud iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create zb-deploy --display-name="ZERO-BIT 反映（GitHub Actions）"
gcloud iam service-accounts describe "$MIGRATE_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create zb-migrate --display-name="ZERO-BIT マイグレーション（Cloud Run ジョブ）"
gcloud iam service-accounts describe "$BACKUP_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create zb-backup --display-name="ZERO-BIT バックアップ（Cloud Run ジョブ）"
ok "zb-run・zb-deploy・zb-migrate・zb-backup"

say "データベース（Cloud SQL・PostgreSQL 16）。はじめては10分ほどかかる"
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE \
    --region="$REGION" --tier="$SQL_TIER" --storage-type=SSD --storage-size=10 --storage-auto-increase \
    --backup-start-time=18:00 --enable-point-in-time-recovery --retained-backups-count="$BACKUPS_KEPT" \
    --retained-transaction-log-days="$LOG_DAYS" --maintenance-window-day=SUN --maintenance-window-hour=19 \
    --deletion-protection --database-flags=timezone=UTC
fi
gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1 ||
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"
CONN=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')
ok "$CONN（毎日 3:00 にバックアップ、$BACKUPS_KEPT 日分。任意の時点に戻せる）"

say "秘密情報（Secret Manager）"
secret_exists() { gcloud secrets describe "$1" >/dev/null 2>&1; }
put_secret() { # 名前 値
  if secret_exists "$1"; then printf %s "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else printf %s "$2" | gcloud secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null; fi
}
ask_secret() { # 名前 説明
  if secret_exists "$1"; then ok "$1（もうある。変えるときは gcloud secrets versions add）"; return; fi
  local v; read -r -s -p "  $2： " v; echo
  [[ -n "$v" ]] || { echo "  空のままにはできません"; exit 1; }
  put_secret "$1" "$v"; ok "$1"
}
# データベースのパスワードは、ここで作って Secret Manager にだけ置く（誰も見なくてよい）
if ! secret_exists db-admin-url; then
  ADMIN_PW=$(rand 40)
  gcloud sql users set-password postgres --instance="$SQL_INSTANCE" --password="$ADMIN_PW" >/dev/null
  put_secret db-admin-url "postgres://postgres:${ADMIN_PW}@localhost/${DB_NAME}?host=/cloudsql/${CONN}"
fi
if ! secret_exists zb-app-password; then
  APP_PW=$(rand 40)
  put_secret zb-app-password "$APP_PW"
  put_secret database-url "postgres://zb_app:${APP_PW}@localhost/${DB_NAME}?host=/cloudsql/${CONN}"
fi
if ! secret_exists zb-backup-password; then
  # バックアップ用のロール zb_backup のパスワード（マイグレーションのジョブが設定する）
  BACKUP_PW=$(rand 40)
  put_secret zb-backup-password "$BACKUP_PW"
  put_secret db-backup-url "postgres://zb_backup:${BACKUP_PW}@localhost/${DB_NAME}?host=/cloudsql/${CONN}"
fi
secret_exists zb-job-secret || put_secret zb-job-secret "$(rand 48)"
ok "db-admin-url・zb-app-password・database-url・zb-backup-password・db-backup-url・zb-job-secret（自動で作った）"
ask_secret google-client-id     "Google ログインのクライアント ID（docs/deploy.md の手順4で作ったもの）"
ask_secret google-client-secret "Google ログインのクライアント シークレット"
if [[ "$ENV_NAME" == prod ]]; then
  # 検証環境には入れない（本物の注文を検証に入れないため。ルール1）
  ask_secret sp-api-client-id     "SP-API のクライアント ID（amzn1.application-oa2-client.…）"
  ask_secret sp-api-client-secret "SP-API のクライアント シークレット"
  ask_secret sp-api-refresh-token "SP-API のリフレッシュトークン（Atzr|…）"
fi

say "書類・写真の置き場所（Cloud Storage）"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  if [[ "$ENV_NAME" == prod ]]; then
    # 帳簿・証憑の保存期間（7年）は消せない。ロック（取り消せなくする）は、運用が決まってから docs/deploy.md の手順で行う
    gcloud storage buckets update "gs://$BUCKET" --retention-period=7y
  fi
fi
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUN_SA" --role=roles/storage.objectCreator >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUN_SA" --role=roles/storage.objectViewer >/dev/null
ok "gs://$BUCKET（画面は書く・読むだけ。消せない）"

say "バックアップの置き場所（大阪の Cloud Storage）"
if ! gcloud storage buckets describe "gs://$BACKUP_BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BACKUP_BUCKET" --location="$BACKUP_REGION" --uniform-bucket-level-access \
    --public-access-prevention --retention-period="$BACKUP_LOCK"
fi
LIFECYCLE=$(mktemp)
cat > "$LIFECYCLE" <<JSON
{"rule": [
  {"action": {"type": "Delete"}, "condition": {"age": ${KEEP_HOURLY},  "matchesPrefix": ["db/hourly/"]}},
  {"action": {"type": "Delete"}, "condition": {"age": ${KEEP_DAILY},   "matchesPrefix": ["db/daily/"]}},
  {"action": {"type": "Delete"}, "condition": {"age": ${KEEP_MONTHLY}, "matchesPrefix": ["db/monthly/"]}},
  {"action": {"type": "Delete"}, "condition": {"age": ${KEEP_YEARLY},  "matchesPrefix": ["db/yearly/"]}}
]}
JSON
gcloud storage buckets update "gs://$BACKUP_BUCKET" --lifecycle-file="$LIFECYCLE" >/dev/null
rm -f "$LIFECYCLE"
gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" --member="serviceAccount:$BACKUP_SA" --role=roles/storage.objectCreator >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" --member="serviceAccount:$BACKUP_SA" --role=roles/storage.objectViewer >/dev/null
ok "gs://$BACKUP_BUCKET（大阪。1時間ごと ${KEEP_HOURLY}日・日 ${KEEP_DAILY}日・月 ${KEEP_MONTHLY}日・年 ${KEEP_YEARLY}日。${BACKUP_LOCK}は誰も消せない）"

say "バックアップの暗号化の鍵（age）"
if ! secret_exists backup-age-recipient; then
  command -v age-keygen >/dev/null || sudo apt-get install -y -qq age >/dev/null
  KEYDIR=$(mktemp -d -p /dev/shm 2>/dev/null || mktemp -d); chmod 700 "$KEYDIR"
  age-keygen -o "$KEYDIR/key.txt" 2>/dev/null
  RECIPIENT=$(age-keygen -y "$KEYDIR/key.txt")
  SECRET_KEY=$(grep '^AGE-SECRET-KEY-' "$KEYDIR/key.txt")
  cat <<KEY

  ───────────────────────────────────────────────────────────────────
  バックアップを戻すときに使う「復号の鍵」です（${ENV_NAME}）。この画面にしか出ません。
  クラウドには置きません。なくすと、バックアップから戻せなくなります。

    ${SECRET_KEY}

  1. パスワード管理ツールに「ZERO-BIT バックアップの鍵（${ENV_NAME}）」として保存する
  2. 紙に書き写して（または印刷して）、パスワード管理ツールとは別の場所に保管する（本番は必ず）
  ───────────────────────────────────────────────────────────────────
KEY
  while :; do
    read -r -s -p "  控えた鍵を、確かめのためにもう一度貼ってください（画面に出ません）： " AGAIN; echo
    [[ "$AGAIN" == "$SECRET_KEY" ]] && break
    echo "  違います。控えた鍵を見直して、もう一度貼ってください"
  done
  shred -u "$KEYDIR/key.txt" 2>/dev/null || rm -f "$KEYDIR/key.txt"
  rmdir "$KEYDIR"; unset SECRET_KEY AGAIN
  put_secret backup-age-recipient "$RECIPIENT"
  clear 2>/dev/null || true
  ok "鍵を控えたことを確かめました。クラウドには公開鍵（暗号化だけできる）だけを置きました"
else
  ok "backup-age-recipient（もうある）"
fi

say "権限"
RUN_SECRETS=(database-url google-client-id google-client-secret zb-job-secret)
[[ "$ENV_NAME" == prod ]] && RUN_SECRETS+=(sp-api-client-id sp-api-client-secret sp-api-refresh-token)
for s in "${RUN_SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
for s in db-admin-url zb-app-password zb-backup-password; do # マイグレーションのジョブだけが使う（画面からは管理者で入れない：ルール2）
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$MIGRATE_SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
for s in db-backup-url backup-age-recipient; do # バックアップのジョブだけが使う
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$BACKUP_SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
for sa in "$RUN_SA" "$MIGRATE_SA" "$BACKUP_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$sa" --role=roles/cloudsql.client --condition=None >/dev/null
done
for r in roles/run.admin roles/artifactregistry.writer roles/cloudsql.editor; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role="$r" --condition=None >/dev/null
done
for sa in "$RUN_SA" "$MIGRATE_SA" "$BACKUP_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$sa" --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser >/dev/null
done
ok "zb-run：アプリ用のDB・秘密情報・ファイル／zb-migrate：管理者でDB／zb-backup：DB を読んで大阪に置く／zb-deploy：反映・反映前のバックアップ"

say "GitHub Actions から鍵なしで反映する設定（Workload Identity）"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe github --location=global --workload-identity-pool=github >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPO}" >/dev/null
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github"
ok "${GITHUB_REPO} からだけ反映できる"

say "独自ドメイン（ロードバランサと HTTPS の証明書）"
gcloud compute addresses describe zerobit-ip --global >/dev/null 2>&1 || gcloud compute addresses create zerobit-ip --global
IP=$(gcloud compute addresses describe zerobit-ip --global --format='value(address)')
gcloud compute network-endpoint-groups describe zerobit-neg --region="$REGION" >/dev/null 2>&1 ||
  gcloud compute network-endpoint-groups create zerobit-neg --region="$REGION" --network-endpoint-type=serverless --cloud-run-service="$SERVICE"
gcloud compute backend-services describe zerobit-backend --global >/dev/null 2>&1 || {
  gcloud compute backend-services create zerobit-backend --global --load-balancing-scheme=EXTERNAL_MANAGED
  gcloud compute backend-services add-backend zerobit-backend --global --network-endpoint-group=zerobit-neg --network-endpoint-group-region="$REGION"
}
gcloud compute url-maps describe zerobit-https --global >/dev/null 2>&1 || gcloud compute url-maps create zerobit-https --global --default-service=zerobit-backend
gcloud compute ssl-certificates describe zerobit-cert --global >/dev/null 2>&1 ||
  gcloud compute ssl-certificates create zerobit-cert --global --domains="$DOMAIN"
gcloud compute target-https-proxies describe zerobit-https-proxy --global >/dev/null 2>&1 ||
  gcloud compute target-https-proxies create zerobit-https-proxy --global --url-map=zerobit-https --ssl-certificates=zerobit-cert
gcloud compute forwarding-rules describe zerobit-https-rule --global >/dev/null 2>&1 ||
  gcloud compute forwarding-rules create zerobit-https-rule --global --load-balancing-scheme=EXTERNAL_MANAGED \
    --address=zerobit-ip --target-https-proxy=zerobit-https-proxy --ports=443
# http:// で来たら https:// へ
if ! gcloud compute url-maps describe zerobit-http-redirect --global >/dev/null 2>&1; then
  cat > /tmp/zerobit-redirect.yaml <<YAML
name: zerobit-http-redirect
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
YAML
  gcloud compute url-maps import zerobit-http-redirect --global --source=/tmp/zerobit-redirect.yaml --quiet
fi
gcloud compute target-http-proxies describe zerobit-http-proxy --global >/dev/null 2>&1 ||
  gcloud compute target-http-proxies create zerobit-http-proxy --global --url-map=zerobit-http-redirect
gcloud compute forwarding-rules describe zerobit-http-rule --global >/dev/null 2>&1 ||
  gcloud compute forwarding-rules create zerobit-http-rule --global --load-balancing-scheme=EXTERNAL_MANAGED \
    --address=zerobit-ip --target-http-proxy=zerobit-http-proxy --ports=80
ok "$DOMAIN → $IP"

say "1時間ごとのバックアップ（Cloud Scheduler → Cloud Run ジョブ zerobit-backup）"
# ジョブは反映（GitHub Actions）のときにできる。それまでは動かしても「ない」と失敗するだけ
BACKUP_ARGS=(--location="$REGION" --schedule="7 * * * *" --time-zone="Asia/Tokyo" --http-method=POST
  --uri="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/zerobit-backup:run"
  --oauth-service-account-email="$BACKUP_SA" --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
  --attempt-deadline=60s)
if gcloud scheduler jobs describe zerobit-backup --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http zerobit-backup "${BACKUP_ARGS[@]}" >/dev/null
else
  gcloud scheduler jobs create http zerobit-backup "${BACKUP_ARGS[@]}" >/dev/null
fi
ok "毎時7分"

if [[ "$ENV_NAME" == prod ]]; then
  say "5分ごとの注文の取り込み（Cloud Scheduler）"
  JOB_SECRET=$(gcloud secrets versions access latest --secret=zb-job-secret)
  make_job() { # 名前 スケジュール モード
    # 合言葉（Bearer）を入れる引数は、作るときは --headers、直すときは --update-headers（名前が違う）。
    # 引数の間違いで gcloud が合言葉を画面に出さないよう、エラーの表示は捨てて、こちらの文だけを出す
    local args=(--location="$REGION" --schedule="$2" --time-zone="Asia/Tokyo" --http-method=POST
      --uri="https://${DOMAIN}/api/jobs/amazon-orders?mode=$3" --attempt-deadline=300s)
    local header="Authorization=Bearer ${JOB_SECRET}"
    if gcloud scheduler jobs describe "$1" --location="$REGION" >/dev/null 2>&1; then
      gcloud scheduler jobs update http "$1" "${args[@]}" --update-headers="$header" >/dev/null 2>&1 ||
        { echo "  ✗ $1 を直せませんでした（gcloud scheduler jobs update http）"; exit 1; }
    else
      gcloud scheduler jobs create http "$1" "${args[@]}" --headers="$header" >/dev/null 2>&1 ||
        { echo "  ✗ $1 を作れませんでした（gcloud scheduler jobs create http）"; exit 1; }
    fi
  }
  make_job amazon-orders "*/5 * * * *" incremental
  make_job amazon-orders-reconcile "40 4 * * *" reconcile
  ok "5分ごと・毎日 4:40 の照合"
fi

cat <<DONE

=====================================================================
✓ ${ENV_NAME} の用意ができました。次の値を docs/deploy.md の手順どおり GitHub に入れてください（秘密ではありません）

  GCP_PROJECT_ID     = ${PROJECT}
  GCP_WIF_PROVIDER   = ${WIF_PROVIDER}
  GCP_DEPLOY_SA      = ${DEPLOY_SA}
  GCP_RUN_SA         = ${RUN_SA}
  GCP_MIGRATE_SA     = ${MIGRATE_SA}
  GCP_SQL_CONNECTION = ${CONN}
  ZB_DOMAIN          = ${DOMAIN}
  ZB_STORAGE_BUCKET  = ${BUCKET}
  ZB_BACKUP_BUCKET   = ${BACKUP_BUCKET}
  GCP_BACKUP_SA      = ${BACKUP_SA}

そしてドメインの DNS に、次の A レコードを足してください（HTTPS の証明書は、足してから 15〜60 分で自動で出ます）

  ${DOMAIN}.   A   ${IP}
=====================================================================
DONE
