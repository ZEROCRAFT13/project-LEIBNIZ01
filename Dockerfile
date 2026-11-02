# 本番・検証のコンテナ（Cloud Run）。リポジトリの一番上で docker build する（db/migrations も入れるため）
# 画面：node server.js ／ マイグレーション：node scripts/migrate.mjs（Cloud Run ジョブで動かす）
FROM node:22.22.0-slim AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22.22.0-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
RUN npm run build

FROM node:22.22.0-slim AS run
WORKDIR /app
ARG ZB_VERSION=dev
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0 ZB_VERSION=$ZB_VERSION
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=node:node db/migrations ./db/migrations
USER node
EXPOSE 8080
CMD ["node", "server.js"]
