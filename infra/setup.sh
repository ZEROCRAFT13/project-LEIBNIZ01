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
#   独自ドメインのためのロードバランサ（HTTPS の証明書は Google が自動で出す）、Cloud Scheduler（5分ごとの注文の取り込み）
# Cloud Run のサービス（画面）とジョブ（マイグレーション）は、GitHub Actions が最初の反映のときに作る。
# =====================================================================
set -euo pipefail

ENV_NAME="${1:-}"; PROJECT="${2:-}"; DOMAIN="${3:-}"
if [[ ! "$ENV_NAME" =~ ^(stg|prod)$ || -z "$PROJECT" || -z "$DOMAIN" ]]; then
  echo "使い方：bash infra/setup.sh stg|prod <プロジェクトID> <ドメイン>"; exit 1
fi
REGION=asia-northeast1
GITHUB_REPO="${GITHUB_REPO:-ZEROCRAFT13/project-LEIBNIZ01}"
SQL_INSTANCE=zerobit-db
DB_NAME=zerobit
SERVICE=zerobit
BUCKET="${PROJECT}-files"
RUN_SA="zb-run@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA="zb-deploy@${PROJECT}.iam.gserviceaccount.com"
MIGRATE_SA="zb-migrate@${PROJECT}.iam.gserviceaccount.com"   # マイグレーションだけ（管理者のパスワードを読めるのはこれだけ）

if [[ "$ENV_NAME" == prod ]]; then
  SQL_TIER=db-custom-1-3840; BACKUPS_KEPT=30; LOG_DAYS=7
else
  SQL_TIER=db-f1-micro;      BACKUPS_KEPT=7;  LOG_DAYS=3
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
ok "zb-run・zb-deploy・zb-migrate"

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
secret_exists zb-job-secret || put_secret zb-job-secret "$(rand 48)"
ok "db-admin-url・zb-app-password・database-url・zb-job-secret（自動で作った）"
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

say "権限"
RUN_SECRETS=(database-url google-client-id google-client-secret zb-job-secret)
[[ "$ENV_NAME" == prod ]] && RUN_SECRETS+=(sp-api-client-id sp-api-client-secret sp-api-refresh-token)
for s in "${RUN_SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
for s in db-admin-url zb-app-password; do # マイグレーションのジョブだけが使う（画面からは管理者で入れない：ルール2）
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$MIGRATE_SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
for sa in "$RUN_SA" "$MIGRATE_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$sa" --role=roles/cloudsql.client --condition=None >/dev/null
done
for r in roles/run.admin roles/artifactregistry.writer roles/cloudsql.editor; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role="$r" --condition=None >/dev/null
done
for sa in "$RUN_SA" "$MIGRATE_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$sa" --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser >/dev/null
done
ok "zb-run：アプリ用のDB・秘密情報・ファイル／zb-migrate：管理者でDB／zb-deploy：反映・反映前のバックアップ"

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

if [[ "$ENV_NAME" == prod ]]; then
  say "5分ごとの注文の取り込み（Cloud Scheduler）"
  JOB_SECRET=$(gcloud secrets versions access latest --secret=zb-job-secret)
  make_job() { # 名前 スケジュール モード
    local args=(--location="$REGION" --schedule="$2" --time-zone="Asia/Tokyo" --http-method=POST
      --uri="https://${DOMAIN}/api/jobs/amazon-orders?mode=$3" --headers="Authorization=Bearer ${JOB_SECRET}"
      --attempt-deadline=300s)
    if gcloud scheduler jobs describe "$1" --location="$REGION" >/dev/null 2>&1; then
      gcloud scheduler jobs update http "$1" "${args[@]}" >/dev/null
    else
      gcloud scheduler jobs create http "$1" "${args[@]}" >/dev/null
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

そしてドメインの DNS に、次の A レコードを足してください（HTTPS の証明書は、足してから 15〜60 分で自動で出ます）

  ${DOMAIN}.   A   ${IP}
=====================================================================
DONE
