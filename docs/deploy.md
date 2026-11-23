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
| Amazon の FBA の在庫と販売の取り込み | しない | 1時間ごと（毎時17分） |

- 画面は Cloud Run、書類・写真は Cloud Storage、キーは Secret Manager に置きます。
- 独自ドメインはロードバランサでつなぎます（HTTPS の証明書は Google が自動で出して更新します）。
- データベースは1時間ごとに暗号化して、書類・写真のファイルは1時間ごとにそのまま、大阪リージョンのバケットに置きます（手順11）。毎月、そこから戻せるかを試します（手順12）。自宅サーバーへのバックアップは、このあと足します（仕様書 7・8章）。

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
   | `SP_API_SELLER_ID` | 本番だけ。出品者 ID（セラーセントラル → 設定 → 出品用アカウント情報 →「出品者トークン」）。自社出荷の出品数を反映するのに要る |
   | `ZB_BACKUP_BUCKET` | `zerobit-prod-123456-backup`（手順11。入れるまでバックアップは動かない） |
   | `GCP_BACKUP_SA` | `zb-backup@….iam.gserviceaccount.com`（手順11） |

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
2. 自社出荷の画面で「Amazon からの取り込み」の最後に成功した時刻が5分ごとに進むことを確かめる。FBA の画面の「FBA の在庫と、組立を始める期限」の取り込みの時刻は1時間ごとに進む（あとから足した定期の取り込みは、`setup.sh` をもう一度動かすと作られる）
3. 事務所の PC で動かしていた `npm run amazon:watch` は**止める**（本番が取り込むので二重にしない）

## 手順11　データベースのバックアップ（1時間ごと・大阪）を動かす

データベースを1時間ごとに書き出し、**age** という方式で暗号化して、大阪リージョンのバケット（`プロジェクトID-backup`）に置きます。書類・写真のファイルも、同じバケットの `files/` に1時間ごとに写します（Storage Transfer Service。消さない・上書きしない）。

- 暗号化に使うのは「公開鍵」だけで、クラウドには公開鍵だけを置きます。戻すときに使う「復号の鍵」は、**パスワード管理ツールと紙の2か所**にだけ控えます（仕様書8章）。なくすと戻せません。
- 置いたものは、本番では14日間、誰も消せません（検証は1日）。そのあと、1時間ごとのものは15日、日ごとのもの（その日の最初の1つ）は91日、月ごとは約13か月、年ごとは約10年で自動で消えます。
- バックアップのジョブ（`zb-backup` アカウント）は、データベースを読むだけで、バケットには足すだけです（消す権限がありません）。
- 1時間半以上成功していないとき、または大きさが急に変わったとき（2倍以上・半分以下）は、ホームに赤い警告が出ます（代表・管理する人だけに見えます）。

**検証から先に**やり、うまくいったら本番も同じようにします。

1. Cloud Shell で `setup.sh` をもう一度動かす（GitHub から新しい `infra/setup.sh` を保存し直してアップロード）。作ってあるものは飛ばし、バックアップの分だけ足します
   ```
   bash setup.sh stg zerobit-stg stg.自社ドメイン
   ```
2. 途中で **復号の鍵**（`AGE-SECRET-KEY-1…`）が1回だけ表示されます
   - パスワード管理ツールに「ZERO-BIT バックアップの鍵（stg／prod）」として保存する
   - 本番の鍵は、紙にも書き写して（印刷でも可）、パスワード管理ツールとは別の場所に保管する
   - 確かめのために、控えた鍵をもう一度貼るよう聞かれます（画面には出ません）。合うまで先に進みません
   - 鍵はチャットや GitHub には貼らないでください
3. 最後に出る `ZB_BACKUP_BUCKET` と `GCP_BACKUP_SA` を、GitHub の Environment（`staging`／`production`）の Variables に足す
4. 反映する（検証は Actions →「反映」→「Run workflow」→ `staging`）。反映の最後に、バックアップを1回とって確かめます
5. 次の毎時7分から、1時間ごとに動きます。Google Cloud の「Cloud Run」→「ジョブ」→「zerobit-backup」で、実行の記録が見られます

ファイルの写し（`files/`）は、あとから `setup.sh` に足しました。前に手順11を済ませた環境でも、新しい `setup.sh` をもう一度動かせば足されます（ほかは作ってあるので飛ばします。鍵も聞かれません）。

## 手順12　毎月の復元の試験

大阪のバックアップから**本当に戻せるか**を、毎月1回試します（仕様書8章）。ホームに「今月の復元の試験がまだです」と出たら、その月の分をやります。10分ほどかかります。業務時間外にやってください（本番のデータベースで少し重い処理をします）。

- 戻す先は、本番の Cloud SQL の中に一時的に作るデータベース（`zerobit_restore_test_日時`）です。本物のデータを検証環境には入れません（ルール1）。終わったら、途中で止まった場合も含めて、必ず消します。
- 復号の鍵は貼るだけで、画面にもファイルにも残りません（メモリの上で使って消します）。

1. Cloud Shell で、最新のスクリプトを取ってくる
   ```
   curl -fsSL -o restore-test.sh https://raw.githubusercontent.com/ZEROCRAFT13/project-LEIBNIZ01/main/infra/restore-test.sh
   ```
2. 動かす（大阪のいちばん新しいバックアップで試します）
   ```
   bash restore-test.sh prod 本番のプロジェクトID
   ```
3. 途中で、パスワード管理ツールの「ZERO-BIT バックアップの鍵（prod）」を貼る（画面には出ません）
4. 最後に「合格：表 ○個の行数がすべて控えと合いました」と出れば終わりです。結果は記録され、ホームの知らせが消えます
   - 「不合格」や「✗」が出たら、表示をそのまま相談してください（鍵の取り違え、バックアップの破損など）
   - 検証でも同じように試せます（`bash restore-test.sh stg 検証のプロジェクトID` と、検証の鍵）

四半期に1回の「自宅のバックアップから戻す訓練」は、自宅サーバーを用意してから足します。

---

## 困ったとき

### 「Error: Forbidden … does not have permission to get URL」と出る

Cloud Run が「ログインしていない人は通さない」設定のままになっています。会社の Google Workspace の下にプロジェクトを作ると、組織のポリシーで「誰でも（allUsers）」に権限を付けられないため、昔の `--allow-unauthenticated` では外せませんでした（反映のログに `Setting IAM policy failed` と出ます）。

今の「反映」は `--no-invoker-iam-check`（Cloud Run 側の確認を切る）を使うので、反映し直せば直ります。急ぐときは Cloud Shell で：

```
gcloud run services update zerobit --project=プロジェクトID --region=asia-northeast1 --no-invoker-iam-check
```

これで誰でも入れるようになるわけではありません。外からはロードバランサ（自社ドメイン）経由でしか届かず（`--ingress=internal-and-cloud-load-balancing`）、画面はアプリの Google ログインで守っています。

### 1つ前の版に戻す（画面）

Cloud Shell で：

```
gcloud run revisions list --service=zerobit --region=asia-northeast1     # 版の一覧（新しい順）
gcloud run services update-traffic zerobit --region=asia-northeast1 --to-revisions=1つ前の版の名前=100
```

マイグレーションは戻りません。データベースも戻すときは次へ。

### ホームに「データベースのバックアップが止まっています」と出る

1. Google Cloud（本番のプロジェクト）→「Cloud Run」→「ジョブ」→「zerobit-backup」→ 最後の実行の「ログ」を見る
2. よくある原因
   - 反映をまだしていない（ジョブがない）→ 手順11の4
   - `backup-age-recipient` や `db-backup-url` がない → `setup.sh` をもう一度動かす
   - データベースが止まっている・メンテナンス中 → 次の回で戻るか、1時間後にもう一度ホームを見る
3. 手で1回動かす：`gcloud run jobs execute zerobit-backup --region=asia-northeast1 --wait`

### 書類・写真の大阪への写しを確かめる

Google Cloud →「Storage Transfer Service」→「zerobit-files-to-osaka」で、1時間ごとの実行が「成功」になっているかを見ます。はじめの1回は、権限が行き渡る前に動いて失敗することがあります（次の回で成功すれば問題ありません）。

### ホームに「バックアップの大きさが急に変わりました」と出る

大量の登録や取り込みをしたあとなら問題ありません（次の回から、その大きさが「ふだん」になっていきます）。
覚えがないときは、データが暗号化されたり消されたりしていないかを、画面で確かめてください。おかしければ、**データベースに手を入れる前に**相談してください。大阪のバックアップは消せない期間があるので、残っています。

### バックアップから戻す（データベース）

まずは Cloud SQL の自動バックアップ（次の「データベースを過去の時点に戻す」）を使います。大阪のバックアップを使うのは、東京のリージョンが止まったときや、Cloud SQL のバックアップごと壊されたときです。

1. 大阪のバケット（`プロジェクトID-backup`）の `db/hourly/年/月/日/` から、戻したい時刻の `.dump.age` と、同じ名前の `.json`（控え）を落とす
2. パスワード管理ツール（または紙）の復号の鍵を、ファイル `key.txt` に1行で保存する
3. 復号して、中身の一覧が出るか確かめる
   ```
   age --decrypt -i key.txt -o db.dump 時分秒.dump.age
   pg_restore --list db.dump | head
   ```
4. 新しい空のデータベースに戻す（管理者で）。`.json` の `tables` に、表ごとの行数が書いてあるので、戻したあとの行数と比べる
   ```
   pg_restore --no-owner --role=postgres -d 新しいデータベース db.dump
   ```
5. 終わったら `key.txt`・`db.dump` を消す（`shred -u key.txt db.dump`）

毎月の試験（手順12）の `infra/restore-test.sh` が、1〜4を自動でやります（戻す先は一時的なデータベースで、最後に消します）。本番を戻すときも、まず試験と同じように一時的なデータベースに戻して中身を確かめてから切り替えます。

### データベースを過去の時点に戻す

- 反映の直前のバックアップ：Cloud SQL →「zerobit-db」→「バックアップ」で「反映の前 …」を選んで復元
- 任意の時点（本番は7日以内）：「バックアップ」→「ポイントインタイム リカバリ」で新しいインスタンスに複製して、中身を確かめてから切り替える
- どちらも、操作の前に必ず今の状態のバックアップを取る

### キーを替える

```
printf %s '新しい値' | gcloud secrets versions add sp-api-client-secret --data-file=-
```

そのあと Actions で本番を反映し直すと、新しい値が読まれます。SP-API のクライアントシークレットは**180日ごと**に替える決まりです。

#### 定期の取り込みの合言葉（zb-job-secret）を替える

Cloud Scheduler が注文の取り込みを呼ぶときの合言葉です。画面やチャットに出てしまったら、すぐ替えます。

1. Cloud Shell で本番のプロジェクトを選び、新しい値を作って入れる（値は画面に出ません）
   ```
   gcloud config set project 本番のプロジェクトID
   openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48 | gcloud secrets versions add zb-job-secret --data-file=-
   ```
2. Actions →「反映」→ `production` で反映し直す（画面が新しい合言葉を読む）
3. `bash setup.sh prod 本番のプロジェクトID app.自社ドメイン` をもう一度動かす（Cloud Scheduler が新しい合言葉を使うようになる）
4. 古い合言葉を使えなくする（`versions list` で一番新しいもの以外の番号を確かめて、`disable`）
   ```
   gcloud secrets versions list zb-job-secret
   gcloud secrets versions disable 1 --secret=zb-job-secret
   ```

2と3の間の数分は、取り込みが失敗します（次の回で戻ります）。

### 書類の保存期間のロック

本番のファイル置き場は「7年は消せない」設定にしてあります（`--retention-period=7y`）。運用が固まったら、取り消せないように**ロック**します（ロックすると期間を短くできなくなります）。

```
gcloud storage buckets update gs://本番のプロジェクトID-files --lock-retention-period
```

## まだ作っていないもの（使い始めてから）

- 自宅サーバーへのバックアップ（自宅から大阪のバケットを取りに行く）と、四半期の復元の訓練
- 設定画面の「今の版・最後のバックアップ・次の更新予定」
