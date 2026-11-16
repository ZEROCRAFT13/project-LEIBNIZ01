# 本番・検証のコンテナ（Cloud Run）。リポジトリの一番上で docker build する（db/migrations も入れるため）
# 画面：node server.js ／ マイグレーション：node scripts/migrate.mjs（Cloud Run ジョブで動かす）
# バックアップ：--target backup で別のイメージにする（pg_dump と age を足したもの）
FROM node:22.22.0-slim AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22.22.0-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
# public/ は中身が無いと git に入らない。無くても下の COPY が通るように作っておく
RUN mkdir -p public && npm run build

# 画面の中身
FROM node:22.22.0-slim AS app
WORKDIR /app
ARG ZB_VERSION=dev
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0 ZB_VERSION=$ZB_VERSION
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts/migrate.mjs /app/scripts/bootstrap-owner.mjs ./scripts/
COPY --chown=node:node db/migrations ./db/migrations

# バックアップ（Cloud Run ジョブ zerobit-backup）：docker build --target backup
#   画面の standalone の node_modules は画面が使うファイルだけに絞られていて、scripts から import できないものがある。
#   バックアップは package-lock.json どおりに本番用の依存（--omit=dev）を入れ直したものを使う
#   pg_dump は本番の DB と同じ 16 のもの（PostgreSQL の公式の apt から）、暗号化は age
FROM node:22.22.0-slim AS backup-deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.22.0-slim AS backup
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl age \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version | grep -q " 16\." && age --version
WORKDIR /app
ENV NODE_ENV=production
COPY --from=backup-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node app/scripts/backup.mjs ./scripts/
USER node
# 使う部品が読み込めるかを、ビルドのときに確かめる（読み込めなければここで止まる）
RUN node --input-type=module -e "await import('@google-cloud/storage'); await import('pg'); await import('/app/scripts/backup.mjs')"
CMD ["node", "scripts/backup.mjs"]

# 画面（いちばん最後の段。--target を付けずに build するとこれになる）
FROM app AS run
USER node
EXPOSE 8080
CMD ["node", "server.js"]
