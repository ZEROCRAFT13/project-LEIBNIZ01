# 本番・検証環境の作り方と反映のしかた（Google Cloud）

はじめて Google Cloud を使う前提で書いています。上から順に進めてください。
キーやパスワードは、この手順の中で**画面に直接打ち込む**だけです。チャットや GitHub には書きません（CLAUDE.md ルール9）。

## 全体の形

| | 検証環境（staging） | 本番環境（production） |
| --- | --- | --- |
| Google Cloud のプロジェクト | 例 `zerobit-stg-…` | 例 `zerobit-prod-…` |
| URL | 例 `https://stg.自社ドメイン` | 例 `https://app.自社ドメイン` |
| データベース | Cloud SQL（小さい構成） | Cloud SQL（毎日バックアップ30日分＋任意の時点に戻せる） |
| 反映 | main に入ったら自動 | GitHub の画面から手で（承認してから）。反映の直前に自動でバックアップ |
| Amazon の注文の取り込み | しない（本物の注文を検証に入れない） | 5分ごと＋毎日 4:40 に照合 |

- 画面は Cloud Run、書類・写真は Cloud Storage、キーは Secret Manager に置きます。
- 独自ドメインはロードバランサでつなぎます（HTTPS の証明書は Google が自動で出して更新します）。
- 大阪リージョンへの複製・自宅サーバーへのバックアップは、本番で使い始めてから足します（仕様書 7・8章）。

**費用の目安**：データベース・ロードバランサ・Cloud Run などを合わせて、2つの環境で月に数千円〜2万円程度の見込みです（使い方と為替で変わります）。正確には [料金計算ツール](https://cloud.google.com/products/calculator) で確かめ、手順3で予算のお知らせを必ず設定してください。

---

## 手順1　請求先アカウントを作る（代表が1回だけ）

1. 会社の Google Workspace のアカウント（代表）で <https://console.cloud.google.com/> を開く
2. 左上のメニュー →「お支払い」→「請求先アカウントを作成」
3. 会社名・住所・支払い方法（クレジットカードなど）を入れる

## 手順2　プロジェクトを2つ作る

1. 画面上部のプロジェクト選択 →「新しいプロジェクト」
2. 名前を `zerobit-stg` にして作る。**プロジェクト ID**（例 `zerobit-stg-123456`）を控える
3. 同じように `zerobit-prod` も作る
4. それぞれのプロジェクトで「お支払い」→ 手順1の請求先アカウントにリンクする

## 手順3　予算のお知らせ（使いすぎ防止）

「お支払い」→「予算とアラート」→「予算を作成」。月の上限（例 3万円）を決め、50%・90%・100% でメールが届くようにします。

## 手順4　Google ログインの設定（OAuth）

本番のプロジェクトで1つ作り、検証と本番の両方で使います。

1. 本番のプロジェクトを選び、メニュー →「Google Auth Platform」（または「API とサービス」→「OAuth 同意画面」）
2. 「ブランディング」でアプリ名を `ZERO-BIT`、ユーザーの種類を「**内部**」（会社の Workspace の人だけ）にする
3. 「クライアント」→「クライアントを作成」→ 種類は「ウェブ アプリケーション」
4. 「承認済みのリダイレクト URI」に2つ足す
   - `https://stg.自社ドメイン/auth/callback`
   - `https://app.自社ドメイン/auth/callback`
5. 出てきた**クライアント ID** と**クライアント シークレット**を控える（手順5で打ち込む。終わったら控えは消す）

## 手順5　Cloud Shell で用意のスクリプトを動かす

Cloud Shell は、ブラウザの中で動くコマンドの画面です。何もインストールしなくて使えます。

1. GitHub でこのリポジトリの `infra/setup.sh` を開き、「Raw」→ 右クリックで保存（`setup.sh`）
2. Google Cloud の画面右上の「**Cloud Shell をアクティブにする**」（`>_` のアイコン）を押す
3. Cloud Shell の「︙」→「アップロード」で `setup.sh` を送る
4. 検証環境から動かす（プロジェクト ID とドメインは自分のものに）
   ```
   bash setup.sh stg zerobit-stg-123456 stg.自社ドメイン
   ```
   - 途中で Google ログインのクライアント ID・シークレットを聞かれるので、手順4の値を貼る（画面には出ません）
   - データベースを作るところで10分ほどかかります
   - 最後に **GitHub に入れる値** と **DNS に足す A レコード** が出るので控える
5. 本番も同じように動かす。本番では SP-API の3つ（クライアント ID・シークレット・リフレッシュトークン）も聞かれます
   ```
   bash setup.sh prod zerobit-prod-123456 app.自社ドメイン
   ```

途中で止まったら、表示を見て直し、同じコマンドをもう一度動かせば続きから進みます。

## 手順6　ドメインの DNS に A レコードを足す

ドメインを管理している会社（お名前.com・Google Domains の移管先・Cloudflare など）の DNS 設定で、手順5の最後に出た2つを足します。

```
stg.自社ドメイン.   A   （検証の IP）
app.自社ドメイン.   A   （本番の IP）
```

足してから 15〜60 分ほどで、HTTPS の証明書が自動で出ます。

## 手順7　GitHub の設定

1. GitHub のリポジトリ →「Settings」→「Environments」
2. `staging` と `production` を作る
3. `production` は「Required reviewers」に自分を入れ、「Deployment branches」を `main` だけにする（承認してから本番に出る）
4. それぞれの Environment の「**Variables**」（Secrets ではない）に、手順5で出た値を入れる

   | 名前 | 例 |
   | --- | --- |
   | `GCP_PROJECT_ID` | `zerobit-prod-123456` |
   | `GCP_WIF_PROVIDER` | `projects/…/locations/global/workloadIdentityPools/github/providers/github` |
   | `GCP_DEPLOY_SA` | `zb-deploy@….iam.gserviceaccount.com` |
   | `GCP_RUN_SA` | `zb-run@….iam.gserviceaccount.com` |
   | `GCP_MIGRATE_SA` | `zb-migrate@….iam.gserviceaccount.com` |
   | `GCP_SQL_CONNECTION` | `zerobit-prod-123456:asia-northeast1:zerobit-db` |
   | `ZB_DOMAIN` | `app.自社ドメイン` |
   | `ZB_STORAGE_BUCKET` | `zerobit-prod-123456-files` |
   | `AUTH_ALLOWED_DOMAIN` | 会社の Workspace のドメイン（例 `example.jp`） |

   どれも秘密の値ではありません（鍵は Google Cloud の中だけにあります）。チャットに貼ってもらえれば、こちらで入れることもできます。
5. はじめの1回は、HTTPS の証明書ができる前に反映が終わることがあります。そのときは Variables に `ZB_SMOKE_TEST` = `off` を入れておき、証明書ができたら消します。

## 手順8　はじめての反映

- **検証環境**：main に何かが入ると自動で「テスト → 反映」が動きます（Actions の画面「反映」）。手で動かすなら「Run workflow」で target に `staging`
- **本番環境**：Actions →「反映」→「Run workflow」→ target に `production` → 承認
  - 反映の前に、データベースのバックアップが自動で取られます
  - マイグレーションは、まだ流していないものだけが流れます（`app/scripts/migrate.mjs`）
- 反映は業務時間外に行います（仕様書 8章）

## 手順9　最初の代表を登録する（環境ごとに1回）

データベースは空なので、ログインできる人がまだいません。Cloud Shell で、代表の Google アカウントを登録します。

```
gcloud run jobs execute zerobit-migrate --region=asia-northeast1 --wait \
  --args=scripts/bootstrap-owner.mjs,代表のメールアドレス,代表
```

これで `https://app.自社ドメイン` から「Googleでログイン」できます。代表がもういれば何もしません。2人目からは画面で足します。

## 手順10　本番で使い始める

1. 「設定 → 機種と構成表」で機種・構成表・Amazon の出品を登録する（部品の型番・仕入先も）
2. 自社出荷の画面で「Amazon からの取り込み」の最後に成功した時刻が5分ごとに進むことを確かめる
3. 事務所の PC で動かしていた `npm run amazon:watch` は**止める**（本番が取り込むので二重にしない）

---

## 困ったとき

### 1つ前の版に戻す（画面）

Cloud Shell で：

```
gcloud run revisions list --service=zerobit --region=asia-northeast1     # 版の一覧（新しい順）
gcloud run services update-traffic zerobit --region=asia-northeast1 --to-revisions=1つ前の版の名前=100
```

マイグレーションは戻りません。データベースも戻すときは次へ。

### データベースを過去の時点に戻す

- 反映の直前のバックアップ：Cloud SQL →「zerobit-db」→「バックアップ」で「反映の前 …」を選んで復元
- 任意の時点（本番は7日以内）：「バックアップ」→「ポイントインタイム リカバリ」で新しいインスタンスに複製して、中身を確かめてから切り替える
- どちらも、操作の前に必ず今の状態のバックアップを取る

### キーを替える

```
printf %s '新しい値' | gcloud secrets versions add sp-api-client-secret --data-file=-
```

そのあと Actions で本番を反映し直すと、新しい値が読まれます。SP-API のクライアントシークレットは**180日ごと**に替える決まりです。

### 書類の保存期間のロック

本番のファイル置き場は「7年は消せない」設定にしてあります（`--retention-period=7y`）。運用が固まったら、取り消せないように**ロック**します（ロックすると期間を短くできなくなります）。

```
gcloud storage buckets update gs://本番のプロジェクトID-files --lock-retention-period
```

## まだ作っていないもの（使い始めてから）

- 大阪リージョンへの複製（データベース・ファイル）
- 自宅サーバーへのバックアップ（自宅から取りに行く）と、毎月・四半期の復元の訓練
- 設定画面の「今の版・最後のバックアップ・次の更新予定」
