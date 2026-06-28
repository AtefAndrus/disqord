---
title: "スケジュール実行（cron）"
status: planned
priority: high
summary: "ユーザ/LLM が登録した定期タスクを承認後にスケジュールし、指定チャンネルへ配信"
---

# スケジュール実行（cron）

## Why

現状の DisQord は「呼ばれたら答える」受動的な bot に留まり、定期的に何かを能動的に届ける手段がない。「平日朝 9 時に AI ニュースを要約してこのチャンネルに投稿」「毎週月曜にリポジトリの未対応 issue をまとめる」といった**定期 LLM タスク**を、自然言語に近い形で登録し、未接続でも動かしたい。

DisQord は既に OpenRouter 呼び出し経路・スラッシュコマンド・SQLite・常駐プロセス（health HTTP サーバ）を持つため、**ジョブテーブル + ティッカー**を足すだけでチャットの仕組みを再利用して実現できる。これは hermes-agent の cron 機能から着想を得つつ、登録時の**承認ゲート**と**自己完結プロンプトの LLM 整形**を加えて安全性を高めたものである。

## 依存 / 関連 change

- 連携（LLM 起点の登録のみ）: [tool-calling-foundation](../tool-calling-foundation/design.md) — LLM が会話中に「cron を作るべき」と判断して `create_cron_job` client tool を呼ぶ経路に必要。`/cron` スラッシュコマンド経路は本基盤に依存しない（先にコマンド経路だけ実装も可能）
- 連携: [chat-response-v2](../chat-response-v2/design.md) — 登録承認の Approve/Reject ボタンと、配信メッセージの整形に V2 を利用
- 連携: [permissions-stats](../permissions-stats/design.md) — 誰が cron を登録/承認できるか、使用統計への計上はこの権限機構に合わせる（暫定は `ManageGuild`）
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — ジョブ実行時の system prompt / モデルは guild/channel 設定を尊重する。**未成立時は system prompt なし・ジョブ保存モデル（or デフォルトモデル）で実行**して degrade（下記「実行（ティッカー）」）
- 連携: [conversation-context](../conversation-context/design.md) — ジョブ実行は会話文脈ゼロだが、`runScheduledJob` が作る単発履歴をオプションで履歴ストアに記録するなら本 change の session/turn モデルに合わせる。v1 は履歴非記録（保存 `prompt` を都度実行するだけ）で本基盤に非依存

## Goals / Non-Goals

**Goals:**

- `/cron` スラッシュコマンド群（add / list / pause / resume / run / remove）でユーザがジョブを管理できる
- 会話中に LLM が必要と判断したら `create_cron_job` tool で**登録を提案**できる（自動登録はしない）
- **登録は必ず承認ゲートを通す**: 整形済みプロンプト + 解釈されたスケジュール + 配信先を提示し、Approve で初めて登録
- スケジュール表現: **簡易インターバル**（`30m` / `every 2h`）/ **cron 式**（`0 9 * * 1-5`）/ **一回限り ISO 日時**。自然言語は LLM が上記いずれかへ変換（NL 日付パーサは自作しない）
- 各ジョブに **IANA タイムゾーン**を持たせ、DST を正しく扱う
- **再起動耐性**: `next_run_at` を DB に永続化し、発火を跨いでも at-most-once。溜まった定期ジョブは起動時に「次の未来スロット」へ fast-forward（取りこぼし連投を防ぐ）
- ジョブ実行は**会話文脈ゼロの新規 `messages` 配列**（[conversation-context](../conversation-context/design.md) の session/turn は作らない）で行うため、保存プロンプトは自己完結している必要がある（LLM 整形でこれを担保）
- 配信は指定チャンネルへ `channel.send`。`[SILENT]` 規約で「特筆事項が無ければ投稿しない」を可能にする
- 暴走/コスト対策: 最小実行間隔・ユーザあたり/guild あたり最大ジョブ数の上限

**Non-Goals:**

- 自然言語日付の独自パーサ実装（LLM に cron/ISO へ変換させる）
- 秒精度・ミリ秒精度スケジューリング（最小粒度は分、ティッカーは 60 秒）
- ジョブ実行結果の永続ログ/再実行履歴（使用統計は [permissions-stats](../permissions-stats/design.md) に委ねる）
- 複数 bot インスタンス間での分散スケジューリング（v1 は単一プロセス前提。`status='running'` の原子的 claim は将来の多重起動にも効くが、リーダー選出までは扱わない）
- ジョブからの tool 実行（コード実行・Web 検索を cron 実行で使うかは将来。v1 はプレーンなチャット応答のみ）

**将来別 change 候補:**

- cron ジョブ内での tool 利用（web 検索・コード実行）→ 各 tool change 成熟後
- 提案カタログ（よくある定期タスクのテンプレ提示）→ 将来

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| スケジューリングライブラリ | **croner v10**（callback なしの compute-only モード）。**`cron` の `nextRun(fromDate)` 計算にのみ使う**。`once` は croner の one-shot API（`getOnce()`）を使わず、登録時の厳格 ISO 検証 + UTC instant 保存 + 実行時 `new Date(expr)` 再パースで扱う | 依存ゼロ・Bun 動作確認済み・cron 式の IANA タイムゾーン + DST を検証済みで扱える。`new Cron(expr)` を callback なしで作るとタイマーを arm せず純粋な計算オブジェクトになる。`once` を croner に載せないのは、絶対 instant 保存で実行時計算を tz 非依存にでき、検証主体を一本化（独自 ISO 検証）できるため |
| 簡易インターバルの扱い | **`kind='interval'` + `expr=interval ms`（文字列保存）で `next = 完了時刻 + N` を自前計算**に確定。cron 式へ正規化する案は非採用（任意秒インターバルが 5 フィールド cron で表現できない・`every 90m` 等が崩れるため） | croner は cron/once 担当。固定インターバルは完了基準の自前計算が確実。LLM には可能なら cron 式、固定間隔なら interval を出させる |
| スケジューリング方式 | DB に `next_run_at` を永続化 + 60 秒 `setInterval` ティッカーで due ジョブを SELECT | プロセス内タイマーにジョブを載せない（再起動で消えない・croner の in-process scheduler は使わない） |
| at-most-once | 発火前に原子的 claim: `UPDATE ... SET status='running', claimed_at=?, claim_id=? WHERE id=? AND status='pending' AND next_run_at<=?` の `changes===1` のみ実行（due 条件と claim_id 払い出しを含む完全形は Design 参照）。次スロットは**実行完了時刻**で計算し条件付き `finish`（`WHERE status='running' AND claim_id=?`）で永続化。claim〜finish 間のクラッシュは**起動時リカバリ**（kind 別: 定期 `running`→`pending`+fast-forward〔exhausted cron は復旧段で終端 `failed`〕 / `once` `running`→終端 `failed`）で回復 | 二重ティック/将来の多重起動でも二重発火しない（SQLite の affected-rows で判定）。永続化 atomicity ではなく起動時リカバリで取りこぼし連投を防ぐ |
| 取りこぼし時 | **fast-forward は (a) 起動時リカバリ後 と (b) stale `running` 復旧後 のみ**で `computeNextRun(now)` を使い未来の最初のスロットへ前進（過去スロットを順に発火しない）。通常ティッカーは claim 時に fast-forward せず「`next_run_at <= now` を 1 回実行 → finish で完了時刻基準の次スロット計算」 | ダウンタイム/固着明けの連投を防ぐ。croner の `nextRun(fromDate)` は fromDate より**後（strictly after）**の最初の発火を返す（境界一致時は次スロット。テストで `0 9 * * *` に `from=09:00:00` 等の境界ケースを検証）。**claim 時に fast-forward すると通常 due ジョブを 1 回も実行せずスキップする**ため、復旧経路に限定する |
| 登録の承認 | **常に Approve/Reject ボタンを挟む**。timeout は default-deny | LLM 起点の自動登録暴走を防ぐ。オーナーのクレジットを定期消費するため明示同意が要る |
| トリガープロンプトの作者 | **LLM が自己完結プロンプトへ整形**（ユーザの曖昧な依頼 → 独立実行可能なプロンプト）。承認画面で全文提示 | cron は会話文脈ゼロで走るため、保存プロンプトが自己完結している必要がある。hermes は「ユーザ文そのまま・承認なし」だが本設計は整形 + 承認で改善 |
| 自然言語スケジュール | LLM に **cron 式 / 固定インターバル（`interval`）/ offset 付き ISO（`once`）**のいずれかへ変換させ、共有の `validateSchedule()` で検証（cron は croner 構築 try/catch + 秒粒度/下限、once は厳格 ISO、interval は分整数倍/下限）。失敗時はユーザに再入力を促す | 日付パーサの自作は壊れやすい。interval も first-class kind なので NL 正規化先に含める。検証はコマンド/tool で同一の共有経路 |
| タイムゾーン決定 | **決定的な precedence**: 明示 `tz` オプション > guild 設定（settings-hierarchy 成立後） > `CRON_DEFAULT_TZ` > `UTC`。解決した tz は**承認カードに必ず表示**し、LLM に暗黙推測させない | コマンド経路と tool 経路で挙動を一致させ、DST 依存スケジュールが意図せず UTC 保存されるのを防ぐ。承認画面で tz をユーザが確認・却下できる |
| 配信先 | ジョブ登録時の channelId に `channel.send`。先頭に `Cronjob: <name>` ヘッダ | 自動投稿であることを明示。スレッドにも対応（channelId にスレッド id を保存） |
| 沈黙配信 | `deliver_silent=1` のジョブのみ、応答が `[SILENT]` のみなら投稿しない（ジョブは実行済みとして次回へ前進）。**フラグは登録時 `silent?` オプション（`/cron add`・`create_cron_job` 共通）で opt-in**し、既定 `0`（常に配信）。承認カードに silent モードを明示 | 「異常時だけ通知」用途。`deliver_silent=1` のとき system prompt に `[SILENT]` 規約を注入して挙動を指示。flag を立てる経路が無いと既定 0 のまま `[SILENT]` がそのまま投稿されてしまうため、登録オプションと承認カード表示を必須にする |
| 実行モデル/プロンプト | ジョブに `model` を保存。**`model` 非 NULL = 登録時スナップショットのモデルで固定実行、`model` NULL = 実行時に現行デフォルトモデルへ動的解決**（明示指定なし時は NULL 保存）。実行時に guild/channel の system prompt を前置（[settings-hierarchy](../settings-hierarchy/design.md)） | スナップショット/動的のどちらかに倒さず両対応にする: 明示モデルは再現性のため固定、未指定はデフォルトモデル変更を追従。NULL/非 NULL の意味を明確化して `model TEXT`（nullable）と整合 |
| LLM 呼び出し経路 | 現 `chatService.generateResponse(guildId, input)` は**モデル上書きも system prompt 前置も受けない**（`settings.defaultModel` 固定・user メッセージ単発）。`cronService` は (a) `chatService` に `model?` / `systemPrompt?` を受けるオーバーロード or 専用メソッドを足すか、(b) `OpenRouterClient.chat()` を直接呼ぶ。**(a) を採用**し、ジョブごとの `model` と settings-hierarchy 由来 system prompt を渡す | cron は guild 設定の `defaultModel` ではなくジョブ保存 `model` で走る必要があり、現シグネチャでは表現できない。streaming は不要（Discord へは一括 send）なので非 stream の `chat()` 系で足りる |
| 上限 | 最小間隔（既定 5 分）・ユーザあたり最大ジョブ数（既定 10）・guild あたり最大（既定 50）を環境変数化。**active quota のカウント対象は非終端ジョブ（`pending`/`running`/`paused`）**で、終端（`done`/`failed`）は除外。上限は **INSERT（新規作成）時に強制**する。`paused` も枠を占有するので「paused を溜め込んで後から一斉 resume で超過」は構造的に起きず、`resume`（`paused`→`pending`）は count-neutral なので別途上限チェック不要（env で上限を引き下げて既存が超過状態でも、新規 INSERT は枠が空くまで拒否しつつ、既存 paused の resume は overage を悪化させないので許可する） | クレジット枯渇 / スパム防止。`done`/`failed` を数えると cleanup まで枠を恒久消費するため除外。`paused` を含めることで stockpile-then-resume を入口（INSERT）で閉じ、resume 経路を単純に保つ |
| 連続失敗の自動停止 | 実行/配信失敗で `fail_count++`、成功で `0` リセット。**定期（cron/interval）は** `fail_count >= CRON_MAX_FAILURES`（既定 3）で `status='paused'` + `next_run_at=NULL` にして登録者へ通知（**`once` は閾値に関係なく初回の実行/配信失敗で終端 `failed`**＝`paused` 化せず `fail_count` 加算は記録のみ・下記 `onFailure`）。**claim〜finish 間の異常終了（crash/hang → stale 復旧）は別カウンタ `stale_count`** で会計し、`>= CRON_MAX_STALE_RECOVERIES`（既定 5）で同様に自動 `paused`。両カウンタとも成功完了でリセット | 削除済みチャンネル/権限喪失/モデル恒常エラーで OpenRouter 課金が無限ループするのを止める。stale を別カウンタにするのは、良性の再起動で in-flight だっただけのジョブを実行失敗と混同せず、かつ toxic な crash ループは止めるため。v1 から有効化（残る未確定は通知 UX のみ） |
| 権限 | 登録/削除/承認は [permissions-stats](../permissions-stats/design.md) に従う。暫定は `ManageGuild` または「本人のジョブのみ操作可」 | 課金が絡むため無制限にしない |

## Design

### 全体フロー

```text
[登録] 2 経路 → 共通の承認カード → 登録
  A. /cron add ─┐
                ├─► (必要なら LLM でプロンプト整形 + schedule 正規化) ─► Approve/Reject ボタン ─► cron_jobs に INSERT
  B. LLM tool ──┘     create_cron_job(name, schedule, prompt, channel?, once?, timezone?, model?)

[実行] 60s ティッカー
  SELECT due → 原子的 claim → 新規 messages 配列で chatService 実行 → channel.send → next_run_at 前進 (once は done)
```

### 変更対象ファイル

**新規:**

- `src/services/cronService.ts` — スケジュール正規化/検証（croner）、due ジョブ取得、原子的 claim の呼び出し、`next_run_at` 計算（`computeNextRun`）、実行ディスパッチ、**stale `running` 復旧と起動時リカバリのオーケストレーション**（repository の stale-row SELECT + パラメータ化 status 書き込みプリミティブを使い、kind 別の復旧分岐〔定期=`stale_count`++・閾値 `paused`・fast-forward／`once`=終端 `failed`〕・`jobLocks` 保持中ジョブの除外・`notifyOwner` を担う。`computeNextRun`/`jobLocks`/通知ポリシーがここに集約されるため復旧判断もサービス層に置く）
- `src/bot/commands/cron.ts` — `/cron add|list|pause|resume|run|remove` スラッシュコマンド群。承認ボタンの押下処理は**共有 in-memory 承認マネージャ + グローバル `interactionCreate` コンポーネントハンドラ**（nonce custom_id `cron:approve|reject:<nonce>` で振り分け）に集約（コマンド経路と tool 経路で同一マネージャ。`awaitMessageComponent` には依存しない。承認フロー参照）
- `src/db/repositories/cronJobsRepository.ts` — `cron_jobs` の CRUD と**原子的 DB プリミティブのみ**: `selectDue`・原子的 `claim`（`status='running'` + `claimed_at`/`claim_id` 払い出し）・条件付き `finish`/`onFailure` 書き戻し（`WHERE status='running' AND claim_id=?`）・`isStillRunning`/`exists`・**stale `running` 行の SELECT**（`selectStaleRunning(threshold)`〔`(id, claim_id, claimed_at)` を返す〕／起動時は全 `running`）・**パラメータ化した status 遷移書き込み**（`pending`/`paused`/`done`/`failed` と `next_run_at`/`last_run_at`/`stale_count`/`fail_count` は呼び出し側〔cronService〕が算出して渡す。stale 復旧書き込みは **claim-conditional**〔`WHERE id=? AND status='running' AND claim_id=? AND claimed_at=?`・`changes===1`〕で ABA を弾く）・件数集計（上限チェック用）。**kind 別の復旧判断（fast-forward・閾値 `paused`・`jobLocks` 除外・通知）はデータ層に置かず cronService が行う**（repository が `computeNextRun`/`jobLocks`/通知などの runtime/service 状態へ依存しないようにし、復旧不変条件の重複実装を避ける）
- `src/llm/tools/createCronJob.ts` — `create_cron_job` client tool（[tool-calling-foundation](../tool-calling-foundation/design.md) に登録、承認カードを出すだけで即登録しない）
- `tests/unit/services/cronService.test.ts` — schedule 正規化/検証（kind 別下限）、`nextRun` 計算、claim の原子性、起動時リカバリ、fast-forward、once の done 化、失敗時遷移、`fail_count` 閾値、`[SILENT]`、sendable ガード
- `tests/unit/commands/cron.test.ts`

**修正:**

- `src/index.ts` — DI 配線（`CronJobsRepository`/`CronService` 生成、`chatService`・`client` 注入）+ 起動時リカバリ（kind 別: 定期 `running`→`pending`+fast-forward〔exhausted cron は復旧段で終端 `failed`〕 / `once` `running`→終端 `failed`、常駐 sweeper と同一ロジック）+ **もともと `pending` だったジョブのみ**を generic fast-forward（`next_run_at < now` の未発火を未来スロットへ前進。**復旧した定期は recovery 段で `computeNextRun(now)`〔未来〕or 終端 `failed` を確定済みなので generic fast-forward の対象外**＝recovered〔attempted〕を未発火 `done` 化しない）+ 60 秒**非再入**ティッカー開始（`tickInProgress` ガード・serialized 実行）。`shutdown()` で `clearInterval` + 実行中 tick の await/abort（既存 `shutdown` に追記。shutdown 起因 abort は `onFailure` に通さず `fail_count` を汚さない・graceful 終了で `running` を残さないのは best-effort で、in-flight 跨ぎは `running` のまま起動時 stale 復旧で回収）。**`CRON_ENABLED=false` なら起動時に cron state を一切変更しない**: 起動時リカバリ（`running`→`pending`）も fast-forward もティッカーも sweeper も走らせない（無効化中の bot が DB の `running`/`next_run_at` を書き換えないことを保証し、再有効化時に通常の起動時リカバリで回収する）。テーブルや repository は生成してよい（`/cron list` 等の参照系を無効時に許すかは下記コマンドで扱う。v1 は登録/実行系を無効化）
- `src/db/schema.ts` — `cron_jobs` テーブル追加（既存の `PRAGMA table_info` パターン）
- `src/services/chatService.ts` — ジョブ実行用の非 stream 経路追加（`model?` / `systemPrompt?` / `signal?` を受ける。下記「LLM 呼び出し経路」決定）
- `src/llm/openrouter.ts` — **`chat()` に `signal?: AbortSignal` を追加**（現状 `chat()` は signal 非対応で `chatStream` のみが受ける。cron の `CRON_JOB_TIMEOUT_MS` abort を非 stream 経路で効かせるために必要）
- `src/config/envVars.ts` — `CRON_ENABLED` / `CRON_TICK_INTERVAL_MS`（既定 60000・**下限 60000** にクランプ。分粒度の Non-Goal と整合し、より速いポーリングは v1 で許可しない） / `CRON_MIN_INTERVAL_SEC` / `CRON_MAX_JOBS_PER_USER` / `CRON_MAX_JOBS_PER_GUILD` / `CRON_DEFAULT_TZ` / `CRON_MAX_FAILURES`（連続失敗で自動 paused、既定 3） / `CRON_JOB_TIMEOUT_MS`（LLM 実行 wall-clock timeout） / `CRON_DELIVER_TIMEOUT_MS`（Discord 配信 timeout・**チャンクごと**に適用） / `CRON_MAX_DELIVER_CHUNKS`（1 ジョブの分割配信メッセージ数の上限。超過分は切り詰め。既定 5。配信の総 wall-clock を有界化し stale 閾値の算定根拠にする） / `CRON_STALE_RUNNING_MS`（stale `running` 判定閾値。**下限 = preflight + LLM + 全チャンク配信 + margin = `CRON_DELIVER_TIMEOUT_MS`(preflight チャンネル fetch) + `CRON_JOB_TIMEOUT_MS`(LLM) + `CRON_MAX_DELIVER_CHUNKS * CRON_DELIVER_TIMEOUT_MS`(分割配信) + margin` にクランプ**し、正当な in-flight ジョブを誤 sweep しない。既定はこの下限値） / `CRON_MAX_STALE_RECOVERIES`（claim〜finish 間の異常終了で stale 復旧された回数の上限。到達で自動`paused`、既定 5。`fail_count` とは別カウンタで toxic crash ループを止める）
- `src/bot/commands/index.ts` — `/cron` 登録
- `src/bot/events/interactionCreate.ts` — 既存の `isButton()` 経路に `cron:approve|reject:<nonce>` の custom_id 振り分けを追加し、共有承認マネージャへ委譲（未知 nonce は inert 応答）
- `package.json` — `croner` 依存追加（v10、MIT、依存ゼロ）

### DB スキーマ

```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,              -- v1 は guild チャンネルのみ（DM 非対応、下記注記）
  channel_id    TEXT NOT NULL,              -- 配信先（スレッド id も可）
  user_id       TEXT NOT NULL,              -- 登録者
  name          TEXT NOT NULL,              -- 表示名（Cronjob: <name>）
  prompt        TEXT NOT NULL,              -- 自己完結した実行プロンプト
  model         TEXT,                       -- NULL ならデフォルトモデル
  kind          TEXT NOT NULL CHECK(kind IN ('cron','interval','once')),
  expr          TEXT NOT NULL,              -- cron 式 / インターバル(ms 文字列) / ISO 日時
  timezone      TEXT NOT NULL DEFAULT 'UTC',-- IANA tz（once は表示用。instant は offset 込みで絶対化済み）
  deliver_silent INTEGER NOT NULL DEFAULT 0 CHECK(deliver_silent IN (0,1)),-- [SILENT] 規約を使うか
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','done','failed')),
  fail_count    INTEGER NOT NULL DEFAULT 0 CHECK(fail_count >= 0), -- 連続失敗数（N 回で自動 paused、成功でリセット）
  stale_count   INTEGER NOT NULL DEFAULT 0 CHECK(stale_count >= 0), -- claim〜finish 間クラッシュ/ハングで stale 復旧された回数（N 回で自動 paused、成功完了でリセット。fail_count と別カウンタ）
  next_run_at   INTEGER,                    -- epoch ms (UTC)。paused/done/failed は NULL 可
  last_run_at   INTEGER,
  claimed_at    INTEGER,                    -- アクティブ claim 時刻（running 中のみ有効、stale sweeper 判定用）。running を抜けるとき NULL
  claim_id      TEXT,                       -- アクティブ claim のトークン（finish/onFailure を claim と突合し、横取り後の遅延書込みを弾く）。running を抜けるとき NULL
  created_at    INTEGER NOT NULL,
  -- 状態機械の不変条件を DB でも強制（新規 CREATE TABLE なので既存行の backfill 不要）:
  CHECK (status NOT IN ('pending','running') OR next_run_at IS NOT NULL),       -- pending/running は next_run_at 必須（pending+NULL の stuck・running の発火スロット欠落を禁止）
  CHECK (status != 'running' OR (claimed_at IS NOT NULL AND claim_id IS NOT NULL)), -- running は claim メタ必須（ABA/stale 突合の前提）
  CHECK (status = 'running' OR (claimed_at IS NULL AND claim_id IS NULL))        -- アクティブ claim メタは running 中のみ（running を抜ける全遷移で NULL クリア）
);
CREATE INDEX IF NOT EXISTS idx_cron_due ON cron_jobs(status, next_run_at);
```

- **DM 非対応**: 既存 `client.ts` は `DirectMessages` intent を持たず、`messageCreate` は DM を早期 return する（[conversation-context](../conversation-context/design.md) も DM は将来）。よって v1 の登録経路（`/cron`・mention）も配信も guild チャンネル前提で、`guild_id` は NOT NULL とする。DM 対応は将来 change。
- スキーマ追加は既存の `applyMigrations`（`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` で列追加判定）パターンに合わせる。既存テーブルが `created_at` を TEXT `datetime('now')` で持つのに対し本テーブルは epoch ms (INTEGER) を採る点は**意図的**（分未満精度の `next_run_at` 計算と比較を一貫した数値で行うため）。
- `created_at` は INTEGER NOT NULL で SQL デフォルトを持たない（epoch ms を SQLite で素直に出せないため）。**全 INSERT は `CronJobsRepository.create()` 経由に集約**し、そこで `Date.now()` を供給する契約とする（コマンド/tool 経路が raw SQL で直接 INSERT しないことをテストで担保。既存テーブルのような列 default には頼らない）。新規 `CREATE TABLE` 時に NOT NULL 列を置く分には既存行が無いので問題ない。
- `last_run_at` の意味は**「最後に*スケジュール*実行を試みた開始時刻」**（claim/tick の `now`、または stale 復旧時の `claimed_at`）と定義する（成功完了時刻ではない）。**ad-hoc 手動実行（非 due の `/cron run` 別パス）は `last_run_at` を更新しない**（claim を経ずスケジュール状態を一切変えないため。手動実行の可視化が要れば将来 `last_manual_run_at` を別列で足す——Open Questions）。次スロットは完了時刻基準なので `last_run_at < next_run_at - 間隔` のように見えうるが、これは「開始 vs 完了」の差として許容。`once` の取りこぼし（fast-forward で `done`）は実行していないので `last_run_at` を更新しない（`NULL` のままで取りこぼしと完了を区別）。
- **`claimed_at`/`claim_id` は「アクティブ claim」のメタデータ**で `running` 中のみ有効。`finish`/`onFailure`・stale 復旧・`pause`/`resume`/`remove` など `running` を抜ける全遷移は **`claimed_at=NULL, claim_id=NULL` をセットで書く**（次回 claim まで stale 値が残らない）。診断用の監査（最後にいつ claim されたか）が将来要るなら、アクティブ列を流用せず別途 `last_claimed_at`/`last_claim_id` を足す（アクティブ claim 突合の意味が曖昧にならないように）。
- **状態機械の DB レベル不変条件（CHECK）**: 設計が「あってはならない」とする状態をスキーマでも弾く（service 層チェックと多重防御）。3 つの CHECK は本設計の全遷移と整合する: INSERT（`pending`・`next_run_at`=first slot 非 NULL・claim メタ NULL）、`claim`（`running`・claim メタ非 NULL）、`finish`/`onFailure`/stale 復旧/`pause`/`resume`/`remove`（`running` を抜けて claim メタ NULL クリア）はすべて 3 制約を満たす。これにより `pending + next_run_at=NULL` の stuck、`running` の claim メタ欠落（ABA/stale 突合不能）、`running` 外に残る stale claim メタ、を DB が拒否する。新規 `CREATE TABLE` なので既存行の backfill は不要。
- **将来 cron_jobs に列追加する場合の注意**: `applyMigrations` の additive パターン（`ALTER TABLE ADD COLUMN`）は、既存行があると **`NOT NULL` 列を default 無しで追加すると失敗**する。後付け列は `DEFAULT` 付きにするか、`nullable で追加 → backfill → （必要なら）制約` の手順を踏む。初回の `cron_jobs` 全列はテーブル新規作成なので対象外。なお SQLite は `ALTER TABLE ADD COLUMN` で **table-level CHECK を後付けできない**（テーブル再構築が要る）ため、上記 CHECK 群は初回 `CREATE TABLE` に含める。

### スケジュール正規化・検証

```ts
// kind 判定 + croner で次回時刻を計算（不正は呼び出し側で try/catch）。
// 戻り null = 「次回なし」（once が過去 / cron が今後発火しない / done 化対象）。
function computeNextRun(kind: string, expr: string, tz: string, from: Date): number | null {
  if (kind === "cron")     return new Cron(expr, { timezone: tz }).nextRun(from)?.getTime() ?? null;
  if (kind === "once")     { const d = new Date(expr); return d.getTime() > from.getTime() ? d.getTime() : null; }
  if (kind === "interval") return from.getTime() + Number(expr); // expr = interval ms（文字列保存）
  throw new Error(`unknown kind: ${kind}`);
}
```

- **NL→schedule 正規化の service 境界（`normalizeCronProposal`）**: 自然言語スケジュールの cron/ISO/interval への変換は専用サービス `normalizeCronProposal(rawSchedule, ctx, signal): Promise<{ kind, expr, tz? } | { error }>` に集約し、`/cron add` と `create_cron_job` の両経路が**同一関数**を呼ぶ（変換主体と検証主体を一本化し、両経路の挙動を一致させる）。手順:
  - (1) **まず決定的に分類**: 入力が既に cron 式（croner で構築可）/ offset 付き ISO / interval 表記（`Ns`・`every Nm` 等）なら **LLM を呼ばず**そのまま `{ kind, expr }` 候補にする。
  - (2) **真に自然言語のときだけ** OpenRouter を **1 回だけ・非 stream・tool 無効・会話文脈なし**で呼ぶ（厳格 JSON `{ kind, expr, tz? }` を出力させる固定 system prompt、モデルは現行デフォルトモデル、`CRON_JOB_TIMEOUT_MS` 級の timeout、`signal` を fetch へ伝播）。**`runToolLoop()` を呼ばず・[conversation-context](../conversation-context/design.md) の session/turn 履歴も読まない**（再帰的な tool ループや会話状態への依存を作らない）。
  - (3) (1)/(2) いずれの候補も**最後に必ず共有 `validateSchedule()`**（kind/expr/tz 確定・kind 別下限・全 kind tz 検証・過去/暦上ありえない日時拒否・first `next_run_at` 非 null 必須）を通す。失敗は `{ error }` で返し、コマンド経路はユーザに再入力を促し、tool 経路は `handler` が `llmResult` の error 文字列でモデルに再考させる。
  - tool 経路では呼び出し中のモデルが `schedule` に具体的な cron/ISO/interval を入れるよう parameters 記述で促すが、NL が来ても同じ normalizer が処理するためコマンド/tool で挙動が一致する（tool 経路で (2) が走っても、それは別の単発呼び出しで現在の tool ループとは独立）。
- **検証（登録時）と実行時計算（computeNextRun）は別フェーズ**。下限チェックは登録時の `validateSchedule()` に集約し、`computeNextRun` は純粋な次回時刻計算に限定する（実行のたびに下限を再検査しない）。
- LLM/ユーザ入力の cron 式は `new Cron(expr, { timezone })` の構築 try/catch で検証（croner は不正パターンを構築時に throw）。
- 一回限りは**登録時に厳格 ISO 8601 検証 + 絶対時刻化**を行う:
  - **コンポーネント単位の厳格検証**（正規表現 + `Date.parse` だけでは不十分）: `Date.parse`/`new Date` は不正な暦日（例 `2025-02-30`・`2025-13-01`・`2025-02-29` の非閏年）を **roll over して受理しうる**（実装/入力依存）。よって正規表現で各フィールドを capture した上で、**月（1-12）・その月・その年の実日数に収まる日（閏年判定込み）・時(0-23)/分(0-59)/秒(0-59)・offset 形式**を明示的にレンジ検証し、capture 値を再構成した instant と入力が一致することを確認して**暦上ありえない日時を拒否**する。`new Date()` は非 ISO の実装依存文字列も受理しうるため、生 `new Date(expr)` だけにも頼らない。過去日時も拒否。
  - **オフセット必須（v1）**: `once` の ISO は `Z` か数値オフセット（`+09:00` 等）を**必須**とし、offset 無しの「壁時計」文字列は拒否する。offset 無しを許すと `new Date(expr)` がホストランタイムの tz で解釈され、ジョブの `timezone` 列と矛盾する。**v1 はサーバ側で「`tz` のローカル壁時計 + IANA tz」→ 絶対 instant 変換を行わない**: JS は標準ライブラリだけでは DST の gap/fold（存在しない壁時計時刻・二重に存在する壁時計時刻）を曖昧さなく解決できず、独自日付パーサ非実装の Non-Goal にも反するため。代わりに**壁時計/自然言語の依頼は LLM が対象日付の具体オフセットへ解決して offset 付き ISO を出す**責務とし（cron 式と同じく LLM 整形フェーズで確定）、承認カードで解決済み absolute instant を提示してユーザが確認・却下できるようにする。サーバ側 wall-clock→instant 変換（明示的な DST gap/fold ポリシー付き）は将来課題（Open Questions）。
  - 検証・正規化後の `expr` は UTC instant を表す ISO（`Z` 付き）として保存し、実行時 `computeNextRun` の `new Date(expr)` は検証済み・絶対時刻の再パースに留まる（`once` は tz 非依存）。`once` の `timezone` 列は**表示用のみ**（instant が offset 込みで絶対化済みのため実行計算には使わない）。
- **timezone は全 kind で独立検証**する（croner 構築時に拾える `cron` だけでなく、`Intl.supportedValuesOf('timeZone')` 照合 or `new Intl.DateTimeFormat(undefined,{timeZone})` の throw で `interval`/`once` の tz も登録時に弾く）。
- **登録時に first `next_run_at` の存在を必須**: `validateSchedule()` は `computeNextRun(kind, expr, tz, now)` を計算し、**戻りが `null` なら登録を拒否**する（cron が exhausted で今後一致スロットが無い〔例 `0 0 30 2 *`〕/ once が過去）。`pending + next_run_at=NULL` は `selectDue` に二度と拾われず stuck になるため、resume・stale 復旧と同じ「次回スロットが無ければ `pending` にしない」不変条件を**登録時にも適用**する（cron 式は構文上 valid でも発火スロットが無ければ拒否）。interval は常に未来なので自動的に満たす。
- インターバル下限 `CRON_MIN_INTERVAL_SEC` の適用方針（kind 別）:
  - `interval`: `Number(expr) >= CRON_MIN_INTERVAL_SEC*1000` を直接検査し、**さらに `Number(expr) % 60000 === 0`（1 分の整数倍）を要求**する。分粒度 Non-Goal + 60s ティッカーと整合させ、秒/ミリ秒インターバルは拒否（`every 90m` 等の分単位のみ許可）。全 kind とも発火は `next_run_at` に対し**最大 1 ティック（≤ `CRON_TICK_INTERVAL_MS`）の遅延**を持つ（ポーリング方式の構造的特性で、分粒度では許容）。`CRON_MIN_INTERVAL_SEC` 自体も分の整数倍を前提（既定 300s = 5 分）。
  - `cron`: 隣接 2 スロットだけでは不十分（非一様な式は最初の 2 スロットが広くても後続に下限未満の隣接が出うる: 範囲指定 `0,1,2 9 * * *`・月/曜制約・DST 前後など）。よって **次 N occurrences（既定 20）を `nextRun` で列挙**し、**隣接間隔の最小**が下限未満なら登録拒否する。croner はスロット計算のみで実発火させないため安全。
    - **列挙窓の定義（best-effort と明記）**: 「N occurrences **または** M 日のいずれか**先**で打ち切る」案は採らない。**日窓を先に打ち切ると疎な式（年次/月次のクラスタ、例 `0,1 0 1 1 *`〔毎年 1/1 に 1 分差で 2 回〕）で 14 日以内に occurrence が 0-1 件しか入らず、1 分差の隣接が一度も比較されないまま通過する**ため。よって**最低 N occurrences を必ず列挙**し（occurrence 件数を主基準）、暴走防止のため**ハード上限 horizon（既定 5 年）**だけを安全網に置く（N 件に達する前に horizon を超えたら、そこまでの隣接で判定）。これでも horizon 越えに初出現する far-future クラスタは原理的に取りこぼしうるため、本チェックは **best-effort（下限の syntactic 保証ではない）**と位置づけ、**実行時ガード（`belowMinCronInterval`、cron 専用）で補完する**: ティッカーは claim 直後・LLM 呼び出し前に、発火スロット `job.next_run_at` の**直後スロット** `computeNextRun("cron", expr, tz, new Date(job.next_run_at))` を求め、その実 ms 差が `CRON_MIN_INTERVAL_SEC*1000` 未満なら、**この式は発火スロット直後の隣接間隔が下限未満（= 構造的に too-dense）**と判断して LLM を呼ばずに `status='paused'`（`next_run_at=NULL`）+ 登録者通知にする（実行ティッカー擬似コード参照）。**ガードの性格（明示）**: これは **式の forward 隣接間隔（発火スロット→式の次スロット）を測る純粋な式評価**であり、`now`/壁時計や successor の時間的位置には依存しない**式ポリシー強制（expression-density enforcement）**である——登録時 N occurrences 列挙のすり抜けを実行時に拾う backstop。よって (a) successor が claim 遅延で既に過去でも（finish 前進で実害の rapid-fire が起きないケースでも）、**式が too-dense なら pause する**（その式は将来スロットで必ず rapid-fire するため、入口で恒久停止するのが正しい）。(b) 一方で **forward 隣接のみ**を見る（直前スロットは見ない）ので「全隣接間隔が下限以上」の完全保証ではない（前スロットとの間隔が小さくても前が未発火なら通過しうるが、その式も別の発火スロットで forward 検査に必ず引っかかるので最終的に pause される）。式固有の too-dense クラスタは skip-and-continue では回復しないため `fail_count` 経由ではなく直接 `paused` にし、誤配信・無駄課金を防ぐ。完全な構造保証の主担当は登録時の N occurrences 列挙（best-effort・horizon 制限つき）で、本ガードはその実行時補完に留まる。
    - **DST 注意**: croner は IANA tz の壁時計スケジュールを尊重するため、`0 2 * * *` 等は DST 切替日に 23/25 時間の「日」を生む。下限は**絶対経過時間（隣接スロットの実 ms 差）**で判定する（壁時計の見かけ間隔ではなく）。23 時間日でも隣接実間隔が下限以上なら許容する。
    - **秒粒度の拒否（分粒度 Non-Goal の強制）**: croner は 6 フィールド（秒付き）パターンも受理するが、60s ティッカーでは秒位置のずれた式（例 daily `09:00:30`）が毎分ポーリングで late fire し分粒度方針に反する。よって列挙した occurrences が**すべて `getSeconds()===0 && getMilliseconds()===0`** であることを要求し、非ゼロ秒の cron 式は登録拒否する（5 フィールド分 cron は常に満たす。6 フィールドでも秒=0 なら許可）。**保存・正規化の不変条件**: 検証通過後の `expr` は**そのまま verbatim 保存**し（受理した 5/6 フィールド形を canonicalize しない）、`computeNextRun` は実行のたび croner で同一文字列を再パース（croner は両形を受理）、`/cron list` も保存値を表示する。秒=0 の 6 フィールドと等価 5 フィールドは同じ発火列を生むため正規化は不要だが、表示/テストが揺れないよう「verbatim 保存・実行時再パース」を repository/service 不変条件として固定する。
  - `once`: 単発なので下限非適用（過去拒否のみ）。ただし上記「first `next_run_at` 非 null 必須」で過去 once は拒否される。
- `expr` カラムは kind により意味が変わる union 文字列（cron 式 / interval ms / ISO 8601）。読み出し側は必ず `kind` で分岐する。

### 実行（ティッカー）

```ts
// 60s ごと（CRON_TICK_INTERVAL_MS、既定 60000・下限 60000）
recoverStaleRunning(Date.now() - STALE_RUNNING_MS); // tick 先頭: 古い running を復旧（pending へ戻し + fast-forward。下記）
const selectNow = Date.now();
const due = repo.selectDue(selectNow); // WHERE status='pending' AND next_run_at <= selectNow
for (const job of due) {
  // 手動実行とティッカーで共有する per-job mutex（単一プロセス内）。取得不可なら別実行中なのでスキップ。
  if (!jobLocks.tryAcquire(job.id)) continue;
  try {
    // 直列 tick では後続ジョブの claim が tick 先頭から数十秒〜数分ずれうるので、claimed_at/last_run_at は
    // tick 先頭 selectNow ではなく「この claim 直前の実時刻」claimNow を使う（stale 会計を実 claim 起点にする）。
    const claimNow = Date.now();                     // 各ジョブの claim 直前に取り直す（selectNow <= claimNow）
    const claimId = crypto.randomUUID();
    // 原子的 claim（多重ティック/将来の多重起動でも二重発火しない）。due 条件も含め、claim_id を払い出す。
    if (!repo.claim(job.id, claimNow, claimId)) continue; // SET status='running', claimed_at=claimNow, claim_id=? WHERE id=? AND status='pending' AND next_run_at<=claimNow
    // 以降の finish/onFailure は WHERE status='running' AND claim_id=claimId で書く（横取り後の遅延書込みを弾く）。
    // ランタイム下限ガード（登録時 best-effort 列挙の補完・cron 専用）。発火スロット→式の次スロットの
    // forward 隣接間隔が下限未満なら「式が too-dense」と判断し LLM 前に pause（式ポリシー強制・壁時計非依存）。
    if (job.kind === "cron" && belowMinCronInterval(job)) {    // 発火スロット→次スロットの実 ms 差 < CRON_MIN_INTERVAL_SEC*1000
      repo.finish(job.id, claimId, { lastRunAt: job.last_run_at, nextRunAt: null, status: "paused", failCount: job.fail_count });
      try { await notifyOwner(job, "最小実行間隔違反で自動停止"); } catch (e) { logger.warn("cron notify failed", e); }
      continue;                                                // LLM を呼ばない（無駄課金を防ぐ）
    }
    const ac = new AbortController(); // LLM fetch を abort できるようにする
    // 1) 配信先 preflight（LLM を呼ぶ前にチャンネル解決・送信可否を確認）。channel fetch も timeout で囲む
    //    （serialized tick + job lock 保持中なので、ここで無限待ちすると cron 全体が固着する）。
    const ch = await resolveSendable(job.channel_id, CRON_DELIVER_TIMEOUT_MS); // fetch reject/timeout も内部 catch → null
    if (!ch) { await onFailure(job, claimNow, claimId); continue; } // ← return ではなく continue（他ジョブを止めない）
    try {
      // LLM は signal で abort、配信は wall-clock timeout（Discord 側はキャンセル不能な点に注意・下記）
      const text = await withTimeout(runScheduledJob(job, ac.signal), CRON_JOB_TIMEOUT_MS, ac); // 新規履歴
      // 送信直前に再確認: 実行中に pause/remove されていれば送らない（remove 後の投稿を抑止）
      if (!(job.deliver_silent && isSilent(text)) && repo.isStillRunning(job.id, claimId)) {
        // deliver は分割送信し、チャンクごとに CRON_DELIVER_TIMEOUT_MS を適用（最大 CRON_MAX_DELIVER_CHUNKS）。
        // 1 チャンク目成功 = 配信成功（throw しない）、0 チャンクのみ throw（下記「分割配信の会計ポリシー」）。
        // shouldSend はスケジュール実行なので claim_id 突合。各チャンク前に再評価。
        await deliver(ch, job, text, CRON_DELIVER_TIMEOUT_MS, () => repo.isStillRunning(job.id, claimId));
      }
      // 次スロットは「実行完了時点の now」で計算し、過去なら fast-forward（長時間ジョブの即時連投を防ぐ）。
      const next = nextSlotAfter(job, Date.now()); // once→null、定期→実行完了後の最初の未来スロット
      // finish は WHERE status='running' AND claim_id=claimId 条件付き（pause/remove 等の外部遷移や横取りなら no-op）
      // 成功完了は failCount/staleCount を 0 にリセット。
      repo.finish(job.id, claimId, { lastRunAt: claimNow, nextRunAt: next, status: next === null ? "done" : "pending", failCount: 0, staleCount: 0 });
    } catch (e) {
      await onFailure(job, claimNow, claimId); // 実行/配信失敗 or timeout
    }
  } finally {
    jobLocks.release(job.id);
  }
}

// 失敗時の次スロットも「現在時刻」で fast-forward 計算（過去スロットへ戻さない）。
function nextSlotAfter(job, atMs) {
  if (job.kind === "once") return null;
  return computeNextRun(job.kind, job.expr, job.timezone, new Date(atMs)); // null なら今後発火しない=done
}

// 実行時下限ガード（cron 専用）: 発火スロット（job.next_run_at）と式の次スロットの
// 実 ms 差が CRON_MIN_INTERVAL_SEC*1000 未満なら true（= 式の forward 隣接が too-dense）。壁時計非依存の式評価。
// 登録時 best-effort 列挙をすり抜けた far-future クラスタ等を実行前に pause する式ポリシー backstop
// （forward 隣接のみ判定＝全隣接の完全保証ではないが、too-dense 式は別の発火スロットで必ず引っかかる）。
// interval/once には適用しない（interval は登録時に下限 + 1 分整数倍を直接検査済み・once は単発）ため
// この関数は kind==='cron' でしか呼ばず、誤用防止に冒頭で型を絞る + assert する。
// 引数型は claim 済み行（DB CHECK + claim 不変条件で next_run_at 非 null 保証）を narrow した
// `next_run_at: number` で受ける（strict TS の null 絞り込みを型で満たす。万一 null なら呼び出し側のバグ）。
function belowMinCronInterval(job: CronJob & { kind: "cron"; next_run_at: number }) {
  if (job.kind !== "cron") throw new Error("belowMinCronInterval: cron 専用");
  const fired = job.next_run_at; // due で claim されたので next_run_at がいま発火するスロット（非 null）
  const nextAfterFired = computeNextRun("cron", job.expr, job.timezone, new Date(fired));
  return nextAfterFired !== null && nextAfterFired - fired < CRON_MIN_INTERVAL_SEC * 1000;
}

// 失敗時。once は常に終端 failed（再試行しない）。定期は fail_count を加算し、
// 閾値到達で自動 paused、未達なら次スロットへ前進。
// finish はいずれも WHERE id=? AND status='running' AND claim_id=claimId（changes===0 なら外部遷移/横取りとして何もしない）。
async function onFailure(job, now, claimId) {
  if (job.kind === "once") {
    // once は CRON_MAX_FAILURES に関係なく終端 failed（=1 でも paused にしない）
    repo.finish(job.id, claimId, { lastRunAt: now, nextRunAt: null, status: "failed", failCount: job.fail_count + 1 });
    return;
  }
  const failCount = job.fail_count + 1;
  if (failCount >= CRON_MAX_FAILURES) {
    repo.finish(job.id, claimId, { lastRunAt: now, nextRunAt: null, status: "paused", failCount });
    try { await notifyOwner(job, "連続失敗で自動停止"); } catch (e) { logger.warn("cron notify failed", e); } // best-effort
    return;
  }
  const next = nextSlotAfter(job, Date.now()); // 定期は現在時刻基準で前進
  if (next === null) {
    // 閾値未達でも今後の発火スロットが無い（例: cron 式が exhausted）= 再スケジュール不能。
    // 直近 attempt は失敗かつ再試行先が無いので終端 failed（done=正常完了ではないので使わない。
    // pending + next_run_at=NULL の stuck は避けつつ「失敗で終わった」事実を保持し、
    // 未発火の取りこぼし done〔fast-forward 経路〕と区別する）。
    repo.finish(job.id, claimId, { lastRunAt: now, nextRunAt: null, status: "failed", failCount });
    return;
  }
  repo.finish(job.id, claimId, { lastRunAt: now, nextRunAt: next, status: "pending", failCount });
}
```

- **実行モデル（v1: serialized + non-reentrant tick）**: ティッカーは `setInterval(CRON_TICK_INTERVAL_MS)` だが、**前 tick の非同期処理が未完なら新しい tick をスキップ**する（`tickInProgress` ガード。重なった tick の並行 `selectDue`/dispatch を防ぐ）。1 tick 内では due ジョブを**逐次（`await` 直列）**に処理し、無制限な並行 fan-out を作らない。トレードオフ: 1 本の長時間ジョブ（最大 `CRON_JOB_TIMEOUT_MS`）が同 tick の後続ジョブと stale sweeper を**最大その時間ブロック**する（分粒度 Non-Goal + 単一小規模 bot 前提で許容。滞留ジョブは次 tick の `selectDue` が拾う）。スループットが要れば**有界並行（semaphore + `CRON_MAX_CONCURRENT_JOBS`）への拡張は将来**（その際も per-job `jobLocks` と in-flight 追跡は維持）。**`shutdown()` の明示ポリシー**: `shuttingDown=true` をセット → `clearInterval` → 実行中ジョブの `AbortController` を発火（LLM fetch を即 abort）→ 実行中 tick の unwind を grace timeout まで await する。**shutdown 起因の abort は `onFailure` に通さない**（再起動はジョブの失敗ではないので `fail_count` を不当に増やさない）: tick の catch は `shuttingDown` を見て、真なら `onFailure` を呼ばず**行を `running` のまま残して**返す。配信中（`deliver`、キャンセル不能）は各チャンク前に `shuttingDown` を見て残チャンクを止める。残った `running` 行は**次回起動時リカバリ**が結果不明として回収する（定期→`stale_count`++ + 前進〔exhausted は `failed`〕／`once`→`failed`）——in-flight 中にいたか送信済みかを知り得ないため、これが正しいセマンティクス。したがって**「graceful 終了で `running` を残さない」は best-effort**: tick 境界（≥60s）で大半のジョブは数秒で完了するため通常は `running` ゼロで落ちるが、in-flight を跨いだ 1 本は意図的に `running` のまま残し起動時 stale 復旧に委ねる（良性再起動 1 回 in-flight = stale 復旧 1 回で、`CRON_MAX_STALE_RECOVERIES` 閾値が許容する。`fail_count` は汚さない）。
- `selectDue` は `status='pending' AND next_run_at <= selectNow`（tick 先頭時刻）を対象とし、`claim` は **`UPDATE ... SET status='running', claimed_at=claimNow, claim_id=? WHERE id=? AND status='pending' AND next_run_at <= claimNow`** で原子化する。**`claimNow` は各ジョブの claim 直前に取り直した実時刻**（直列 tick で後続ジョブが tick 先頭から数十秒〜数分遅れて claim されるため、`claimed_at`/`last_run_at` を `selectNow` で記録すると stale 会計が実態より古くなり `CRON_STALE_RUNNING_MS` 下限算定〔claim 後の所要のみ想定〕が崩れる）。`selectNow <= claimNow` なので `next_run_at <= claimNow` は依然 due を満たし、resume 等が `next_run_at` を**未来（> claimNow）**へ動かした行は claim で弾かれる（due 再検証は claim 時刻基準で正しい）。status だけでなく **due 条件も atomic update に含める**ことで、selectDue と claim の間に別経路（`/cron resume` 等）が `next_run_at` を将来へ動かした行を stale tick が誤って claim・実行するのを防ぐ。`changes===1`（=この claim が勝者）のときだけ実行へ進む。`isStillRunning(job.id, claimId)` は **claim_id 突合つき**（`WHERE id=? AND status='running' AND claim_id=?`）で、`finish`/`onFailure` と同一述語にする。status 単独確認は「per-job mutex が同プロセス内の再 claim を防ぐ」前提でしか正しくない（mutex が ABA を覆う DB 書込みと違い、**送信は副作用で claim_id 突合の外側**にあるため、stale 復旧/将来の多重起動で行が別 claim へ横取り＝再 `running` 化された後に古い実行が `status='running'` を見て誤配信しうる）。claim 突合にすれば「自分の claim が今も生きている」ときだけ送るので、横取り後の遅延配信を弾ける。
- `finish` / `onFailure` の書き戻しは **`WHERE id=? AND status='running' AND claim_id=?`**（claim 時に払い出した `claimId`）条件付きにする（`changes` で勝敗判定）。`status='running'` 条件だけでなく **`claim_id` 突合**も入れるのは、stale sweeper が当該行を別 claim へ横取り（再 `running` 化）した後に、古い実行が遅れて `finish` してしまう「ABA 問題」を防ぐため。実行中にユーザが `/cron pause`・`/cron remove` で遷移させた場合も `changes===0` で no-op し、**外部遷移を復活させない**。`/cron pause|resume|remove` 側も「`running` を直接いじらない or 遷移を尊重」する規約にする（下記コマンド設計）。
- **共有 mutex（手動実行との排他）**: ティッカー実行と `/cron run` は**同一の per-job in-memory mutex（`jobLocks`）**を必ず取得する。手動実行は DB claim を経ない（スケジュールを進めないため）ので、status は `pending` のままになり得る。mutex を共有しないと、手動実行開始直後にティッカーが同ジョブを `pending` のまま claim して二重投稿しうる。単一プロセス前提なので in-memory mutex で十分。
- **timeout のセマンティクス（キャンセル保証の限界）**: `withTimeout` は元の Promise を強制終了しない。**timeout 発火後は元 Promise に遅延 settle 観測用の `.catch()`（必要なら `.then`）を必ず付け**、後から来る reject/resolve を debug/warn ログで握って **unhandled rejection を防ぐ**（元 Promise を kill できないため、放置すると timeout 済みの fetch/send が後から reject して unhandled promise rejection になる）。よって (a) `runScheduledJob` は `AbortSignal` を受けて **OpenRouter fetch を実際に abort** する（既存 `chatStream(req, signal)` 同様、cron 経路も非 stream で signal を通す）。(b) Discord `deliver` は API 側でキャンセル不能なため、`CRON_DELIVER_TIMEOUT_MS` 後に `onFailure` へ進めても**元の `send` が後から成功して遅延投稿される可能性がある**（= 投稿 + 失敗会計の二重計上）。`CRON_DELIVER_TIMEOUT_MS` は「status 固着防止」であって「送信抑止」ではない（tool-calling-foundation の「実行結果不明」セマンティクスと同じ）。よって `CRON_DELIVER_TIMEOUT_MS` は**通常の Discord レイテンシより十分に長く**取り（誤 timeout を稀にする）、delivery timeout は `fail_count` を加算する明確な失敗ではなく「結果不明」として扱う方針も選択肢（v1 はシンプルさのため通常失敗扱い + 長め timeout で許容）。なお**複数チャンク分割時の partial 配信（chunk1 成功・chunk2 失敗/timeout）は下記「分割配信の会計ポリシー」で success 扱い**とし `onFailure` に落とさないため、この「遅延着弾による二重計上」懸念は **1 チャンク目の `send` が timeout して `onFailure` に落ちたが send が後から着弾する単発ケースに限定**される。
- **stale `running` 復旧（常駐 + 起動時）**: timeout を貫通したハングや claim〜finish 間クラッシュで行が `running` のまま固着しうる。よって `recoverStaleRunning(threshold)` を **毎 tick 先頭**でも走らせ、`claimed_at < now - STALE_RUNNING_MS` の `running` を復旧する。
  - **復旧書き込みも claim-conditional（ABA 防止）**: sweeper は `selectStaleRunning(threshold)` で `(id, claim_id, claimed_at)` を読んだ後、復旧 `UPDATE` を **`WHERE id=? AND status='running' AND claim_id=? AND claimed_at=?`**（観測した active claim と突合）+ `changes===1` 条件付きにする。SELECT と書き込みの間に別経路（`/cron pause|remove`・別 claim への横取り・将来の多重起動）が status/claim_id を変えていれば `changes===0` で**スキップ**する（id 単独 UPDATE だと新しい状態や新しい `claim_id=B` を古い recovery が上書きしてしまう）。これは `finish`/`onFailure` の claim_id 突合と同じ ABA 不変条件を復旧経路にも適用するもの。kind 別:
  - 定期（cron/interval）: **`stale_count` を +1**（claim〜finish 間でクラッシュ/ハングした＝結果不明の異常終了として会計。`fail_count`〔実行/配信の失敗〕とは別カウンタ）。`stale_count >= CRON_MAX_STALE_RECOVERIES` なら**自動 `paused`**（`next_run_at=NULL`）+ 登録者通知にして toxic な crash ループを止める（良性の再起動で 1 回 in-flight だっただけのジョブを即停止しないため閾値方式）。未達なら `pending` へ戻し `computeNextRun(now)` で `next_run_at` を未来スロットへ**前進**させ、**`last_run_at = claimed_at`**（既に claim され実行を試みた開始時刻なので schema 定義「最後に実行を試みた開始時刻」に合わせる）をセットする（過去のまま戻すと同 tick の `selectDue` が即 catch-up 再発火し「過去スロットを順に発火しない」方針に反する）。**`computeNextRun(now)` が `null`（今後一致スロットの無い exhausted cron）なら `pending` 化せず終端 `failed`**（`pending + next_run_at=NULL` の stuck を避けつつ、stale `running` は **claim 済み = 実行を試みて結果不明**なので、未発火 `pending` の取りこぼし `done` とは区別して `failed` を使う〔`onFailure` の periodic-exhausted→`failed` と一致。`done`=正常完了/未発火取りこぼし専用、`failed`=実行を試みた/結果不明専用という予約を守る〕。なお stale 復旧では recovery 段で computeNextRun(now) を評価して `failed`/`pending`(+future slot) を直接決め、generic な `pending` fast-forward 段には委ねない〔委ねると recovered〔attempted〕と originally-pending〔未発火〕が `pending` で同一視され、exhausted が誤って `done` 化するため〕）。`interval` は `now + N` で必ず未来になるので null にならない。`stale_count` は次の**成功完了**（`finish` success）で 0 にリセットする。
  - `once`: stale `running` の once は「未発火」ではない（LLM/送信フェーズまで進んでからクラッシュした可能性があり、結果不明）。よって `pending` へ戻さず **終端 `failed`**（結果不明として記録、`last_run_at` は claim 時刻）にする。再試行すると at-most-once を破るため。将来 `unknown` ステータスで「結果不明」を明示するのは Open Questions。
  - **現プロセスが実行中のジョブは sweep しない**: `jobLocks` で保持中（= このプロセスの in-flight）の job.id は sweeper の対象から除外する。これと `claim_id` 突合により、現プロセスの正常実行を誤って横取り・二重計上しない。常駐 sweeper の主目的は**前プロセスのクラッシュ残骸**であり、現プロセスの timeout 後始末は timeout→`onFailure` 経路が担う。`STALE_RUNNING_MS`（= 環境変数 `CRON_STALE_RUNNING_MS`、起動時に下限へクランプ済み）は誤判定回避のため**正当な claim 済み実行の最大所要時間以上**にする: claim 後の処理は preflight チャンネル fetch（`CRON_DELIVER_TIMEOUT_MS`）+ LLM（`CRON_JOB_TIMEOUT_MS`）+ 分割配信（最大 `CRON_MAX_DELIVER_CHUNKS` チャンク × `CRON_DELIVER_TIMEOUT_MS`）の直列なので、下限は `CRON_DELIVER_TIMEOUT_MS + CRON_JOB_TIMEOUT_MS + CRON_MAX_DELIVER_CHUNKS*CRON_DELIVER_TIMEOUT_MS + margin`。配信チャンク数を `CRON_MAX_DELIVER_CHUNKS` で上限化することでこの値を有界に保つ。起動時は in-flight が無いので全 `running` 行を**同じ kind 別ロジック（`stale_count`++・閾値 `paused` を含む）**で復旧する（下記）。
- **`next_run_at` 前進セマンティクス（不変条件）**: 次スロットは **`finish` 直前に「実行完了時点の now」で `nextSlotAfter` 計算**する（claim 時点ではない）。長時間ジョブ（例: 5 分間隔ジョブが 10 分かかる）で算出スロットが既に過去になる問題を避けるため、`computeNextRun` は常に「現在時刻より後」の最初の未来スロットを返す（過去スロットの即時連投を防ぐ・「過去スロットを順に発火しない」方針と一致）。`interval` は **完了基準**（`last 完了 + N`）で、開始基準ではない（実行が間隔より長くても重複起動しない）。永続化は `finish` 時のみで、claim〜finish 間クラッシュは上記 stale 復旧 + 起動時 fast-forward で回復する（= 永続化 atomicity ではなく復旧で at-most-once を担保）。
- 起動時リカバリ（fast-forward の前段）: クラッシュで `running` のまま残ったジョブを復旧する。**v1 は単一プロセス前提なので、起動時点の `running` は前プロセスのクラッシュ残骸**と見なす（将来の多重起動では「`claimed_at` が一定時間より古い `running`」だけを戻す stale sweeper に拡張）。これをしないと crash 中に `running` 化したジョブが二度と発火しない。**起動時リカバリは常駐 stale sweeper と同一の kind 別ロジックを使う**（一律 `pending` 戻しはしない。下記の理由で `once` を取りこぼし `done` と誤認するため）。いずれも `running` を抜けるので `claimed_at`/`claim_id` を NULL クリアする:
  - 定期（cron/interval）の `running`: 常駐 sweeper と同一に **`stale_count` を +1**（前プロセスが claim〜finish 間で異常終了した記録）し、`stale_count >= CRON_MAX_STALE_RECOVERIES` なら**自動 `paused`**（toxic crash ループ防止）。未達なら recovery 段で `computeNextRun(now)` を評価し、**未来スロットがあれば `pending` + その `next_run_at`（**`last_run_at = claimed_at`**をセット）、`null`（exhausted cron）なら終端 `failed`**（claim 済み = 実行を試みた結果不明なので、未発火 `pending` の取りこぼし `done` ではなく `failed`。sweeper と完全一致）。**この recovered 定期ジョブは generic な起動時 fast-forward 段（`pending` の未発火を `done` 化しうる）には渡さない**（recovered〔attempted〕と originally-pending〔未発火〕を混同しないため）。`stale_count` は次の成功完了でリセット（sweeper と同一）。
  - `once` の `running`: **終端 `failed`**（`last_run_at = claimed_at`〔= 直近 claim 時刻〕）。stale `once` は「ダウンタイム中に発火時刻を過ぎた未発火」ではなく「LLM/送信フェーズまで進んでからクラッシュした**結果不明**」であり、`pending` に戻して fast-forward に通すと（once は `computeNextRun→null` なので）`done`（= 取りこぼし）に倒れて結果不明と取りこぼしを取り違える。常駐 sweeper の stale `once`→`failed` と完全に一致させる。
- 起動時 fast-forward: **もともと `pending` だったジョブ**（ダウンタイム中に発火時刻を跨いだ未発火）を対象に、**`next_run_at < now`（厳密に過去 = 取りこぼしたスロット）**を `computeNextRun(kind, expr, tz, now)` で未来スロットへ更新（過去スロットを順次発火しない）。**`running` から復旧した定期ジョブは recovery 段で既に次スロット〔computeNextRun(now)・厳密に未来〕or 終端 `failed` を確定済み**なので、この generic fast-forward は実質それらに作用しない（未来 `next_run_at` は `< now` 述語に該当せず・`failed` は `pending` でない＝対象外。recovered〔attempted〕を未発火 `done` 化しない不変条件を保つ）。**境界一致（`next_run_at === now`）は fast-forward の対象にしない**: それは「取りこぼした過去スロット」ではなく「いま due なスロット」なので、ticker の `selectDue`（`next_run_at <= now`）が 1 回実行するに任せる（startup で strictly-after の `computeNextRun(now)` を当てると、本来 1 回実行すべき境界スロットを飛ばしてしまうため）。`once` も同様に `next_run_at === now` は fast-forward の `done` 化対象にせず ticker に実行させる。`computeNextRun` が `null` を返す（= 今後発火しない）ジョブの終端遷移は次の通り（**対象は未発火の `pending` ジョブのみ**。`running`→`failed` にした stale `once` はここに来ない）:
  - `once`（`pending` のままダウンタイム中に発火時刻を過ぎた未発火）: **`done`**（過去の単発は back-run しない。実行はしていないので `last_run_at` は `NULL` 据え置き）。「ダウンタイムで取りこぼした」ことは `/cron list` で `done` + `last_run_at=NULL` から判別でき、必要なら将来 `missed` ステータスを足す（Open Questions）。
  - `cron`（今後一致スロットが無い式）: **`done`**。
  - `failed` は「実行を試みて失敗 / 結果不明」専用に予約し、fast-forward の未発火終了（`pending` の取りこぼし）には使わない（実行失敗・結果不明と単純な未発火を区別する）。
- ジョブ実行 `runScheduledJob(job, signal)` は会話履歴を渡さず、**毎回新規の OpenRouter `messages` 配列**を組む（[conversation-context](../conversation-context/design.md) の session/turn レコードは作らない＝v1 は履歴非記録）。保存 `prompt` を user メッセージとし、guild/channel の system prompt を前置（settings-hierarchy 未成立時は前置なし）。**`deliver_silent=1` のジョブは system prompt 末尾に `[SILENT]` 規約**（特筆事項が無ければ本文を `[SILENT]` のみにせよ）を注入する（フラグ 0 なら注入しない＝常に通常応答）。tool は v1 では渡さない。実 LLM 呼び出しは上記「LLM 呼び出し経路」決定に従い、**`model` 非 NULL ならそのモデル、NULL なら実行時の現行デフォルトモデル**で行い、`signal` を OpenRouter fetch へ通して timeout 時に abort する。
- **`remove`/`pause` 中の送信抑止**: 送信直前（および分割配信時は**各チャンク送信前**）に `shouldSend()` を評価する。**スケジュール実行**は `repo.isStillRunning(job.id, claimId)`（= `WHERE status='running' AND claim_id=?` 確認）で、実行中にユーザが pause/remove していたら（行が `running` でなくなる or claim_id が変わる）送らない/以降のチャンクを止める。**ad-hoc 手動実行**は claim を持たないので `repo.exists(job.id)`（remove で停止）を述語にする。これで `remove` 後の遅延投稿を best-effort に抑止する（ただし `send` 発行後の遅延成功は上記 timeout 同様にキャンセル不能）。claim_id 突合は同時に「stale 復旧/将来の多重起動で別 claim へ横取りされた行に古い実行が誤配信する」のも防ぐ（status 単独だと横取り後の再 `running` を自分のものと誤認する）。
- **ロック内の全外部 await は timeout-bounded**: serialized 非再入 tick + per-job `jobLocks` 保持中に外部 I/O が無限待ちすると、その job が `running` のまま固着し（jobLocks 保持で sweeper も除外）tick も塞がって **cron 全体がデッドロック**する。よって LLM 実行・配信だけでなく**チャンネル fetch（preflight）・登録者通知（`notifyOwner`）・将来の任意 Discord API 呼び出しも全て timeout で囲む**。preflight timeout は `onFailure` へ、`notifyOwner` は短い best-effort timeout + ログ（throw/timeout を握って tick を止めない）。
- 配信先 preflight `resolveSendable(channelId, timeoutMs): Promise<SendableChannel | null>`: `client.channels.fetch(channelId)` を `timeoutMs` で囲み（hang 防止）、**`null` / 非テキストチャンネルを返しうる**ため `ch?.isTextBased() && ch.isSendable()`（discord.js v14 の sendable 判定）で**型ガード**し、true のときだけ返す（fetch reject/timeout は内部 catch → `null`）。戻り型は discord.js の sendable 系 union（`isSendable()` が絞り込む型。明示するなら `Extract<Channel, { send: (...args: never[]) => unknown }>` 相当のローカル別名 `SendableChannel`）にして、`deliver(ch, ...)` が strict TS 下で `ch.send(...)` を型付きで呼べるようにする。**LLM 呼び出しの前**に実行し、不能なら LLM を呼ばずに `onFailure` へ（削除済みチャンネル等で毎回 OpenRouter 課金が走るのを防ぐ）。preflight 通過後に**最初の `send`** が throw（一時的権限変動）して 0 チャンクなら catch → `onFailure`（2 チャンク目以降の throw の扱いは下記「分割配信の会計ポリシー」で success 側）。
- 配信は `allowedMentions: { parse: [] }` 固定（保存プロンプト/応答に `@everyone` 等が混入しても発火させない）。`Cronjob: <name>` ヘッダを含めても合計 2000 字制限を超える場合は分割 or 末尾切り詰めが要る（既存のチャット分割ロジックを流用）。**分割は最大 `CRON_MAX_DELIVER_CHUNKS` メッセージまで**とし、超過分は末尾切り詰め（総配信 wall-clock を有界化し `CRON_STALE_RUNNING_MS` 算定の前提を守る）。
- **分割配信の会計ポリシー**: `deliver` は**1 チャンク目の送信成功をもって配信成功**（会計上 success: `next_run_at` 前進 + `fail_count` リセット）とし、以降のチャンク送信失敗/timeout は **best-effort ログのみで `throw` しない**（= `onFailure`/再試行に落とさない）。**1 チャンク目成功後に途中チャンクが失敗/timeout したら、ログを残して残りのチャンク送信も停止する**（success 会計は維持）: Discord `send` はキャンセル不能なので、timeout したチャンクが後から着弾すると後続チャンクと順序が乱れ partial 出力が分かりにくくなるため、欠落チャンク以降は送らず打ち切る。1 チャンク目すら送れなければ `throw`（→ `onFailure`）。理由: (a) chunk1 成功 + chunk2 失敗のような partial 配信を「失敗」計上して `fail_count` を不当に増やさない、(b) 定期ジョブの次回発火は**新規 LLM 実行による別 content** であり「同一スロットの再送による内容重複」は構造的に起きない（`once` は終端で再試行しないので重複しない）。`CRON_DELIVER_TIMEOUT_MS` は**チャンクごと**に適用し未送信状態の固着を防ぐ目的で、1 チャンク目成功後の遅延は success 扱い（全チャンクをまとめて 1 つの timeout で包まない）。`deliver(ch, job, text, timeoutMs, shouldSend)` は**各チャンク送信前に `shouldSend()` 述語を再評価**し、false なら**以降のチャンク送信を停止**する（発行済み send は取り消せないが未送信チャンクは止められる）。`shouldSend` は経路で異なる: **スケジュール実行は `() => repo.isStillRunning(job.id, claimId)`**（`status='running' AND claim_id=?`。pause/remove/横取りで止まる）、**ad-hoc 手動実行（`/cron run` の claim を経ない別パス）は claim を持たないため `() => repo.exists(job.id)`**（実行中に remove されたら止める。下記コマンド設計）。`deliver` 自体は `running`/claim_id を直接知らず、述語だけを受け取る。

### 登録の承認フロー

- `/cron add`: オプション（`schedule` / `prompt` / `name` / `channel?` / `tz?` / `model?` / `silent?`）。`model?` を渡すと登録時スナップショットのモデルで固定実行（`model` 非 NULL 保存）、省略時は実行時に現行デフォルトモデルへ動的解決（`model` NULL 保存）。`silent?`（真偽・既定 false）は `deliver_silent` に保存し、true のとき `[SILENT]` 規約で「特筆事項が無ければ投稿しない」を有効化する。`prompt` が曖昧/会話依存なら LLM で自己完結プロンプトへ整形し、`schedule` が自然言語なら cron/ISO へ変換。整形結果（プロンプト全文・解釈スケジュール・次回実行時刻・配信先・silent モードの有無）を **Approve/Reject ボタン付きカード**で提示。
- `create_cron_job` tool（LLM 起点）: LLM が `{name, schedule, prompt, channel?, once?}` を渡す。tool ハンドラは**登録せず**同じ承認カードを返す（ephemeral or 当該チャンネル）。Approve で初めて INSERT。
- 承認は **共有 in-memory 承認マネージャ**で扱う（コマンド経路と tool 経路で統一）: nonce をキーに「正規化済み・検証済み payload + 登録者 id + guild/channel scope + 期限」を保持し、Approve/Reject ボタンの custom_id に nonce を載せる（例 `cron:approve:<nonce>` / `cron:reject:<nonce>`）。押下は**グローバル `interactionCreate` のコンポーネントハンドラ**が custom_id prefix で振り分ける。**`awaitMessageComponent`（メッセージ別コレクタ）は使わない**: tool 経路ではカード描画が tool handler の戻り後に updater 経由で行われ、handler 内でそのメッセージを await できないため。押下者が登録者本人（or 権限機構の許可者）かはハンドラ内で検証する（旧 `filter` 相当）。
- 承認の timeout は**マネージャの期限 sweep で default-deny**（期限切れ nonce は破棄し、以後の押下は inert に応答）。`awaitMessageComponent` の `time` には依存しない。
- 承認時に上限チェック（ユーザ/guild ジョブ数、最小間隔）。超過は理由を提示して拒否。
- **Approve 時に権限・scope を再チェック**: ボタンの `filter` で押下者が登録者本人（or 権限機構の許可者）であることを確認するだけでなく、**INSERT 直前に登録者の現在の権限と対象 scope（guild/channel への送信権・登録権）を再評価**し、カード提示〜Approve の間に権限喪失/チャンネル変更があれば INSERT しない（理由を提示）。承認待ちの時間差で失効した権限のまま登録されるのを防ぐ。
- **配信先チャンネルの guild 帰属を必須検証**（`channel?` override 対策）: ユーザ/LLM が `channel?` を渡した場合、解決したチャンネル（スレッドなら親チャンネル）の guild が**ジョブの `guild_id`（= `ctx.guildId`）と一致する**ことを INSERT 直前に検証し、**別 guild のチャンネル ID は bot が送信可能でも拒否**する（cross-guild 配信の防止）。あわせて (a) bot が**その特定チャンネル**へ送信権を持つ（`channel.permissionsFor(client.user)`）、(b) 登録者が**そのチャンネル**への登録権限を持つ（権限機構）を確認する。`channel?` 省略時は登録元チャンネル（`ctx.channelId`）を使い、これは定義上同一 guild なので帰属チェックは自明に満たす。
- **検証済み正規化 payload を承認に載せる**: 承認カード提示**前**に schedule 正規化（kind/expr/tz 確定）+ 全検証（cron/once/interval・下限・tz・過去拒否）を済ませ、マネージャ内の承認 payload には**正規化済み・検証済みの値**だけを保持する（生の LLM/ユーザ入力は載せない）。Approve 時の INSERT 直前に**もう一度同じ検証 + 上限 + 権限/scope を再実行**（defense-in-depth: 上限は承認までの間に他ジョブ追加で超過しうる・権限は失効しうるため必ず再チェック、検証も再確認）してから `CronJobsRepository.create()` で INSERT する。
- **Approve 押下と INSERT の原子性**: 二重押下や 2 つの承認待ちの並行 Approve で**重複 INSERT / 上限超過**が起きないよう、承認前の再チェックだけに頼らず原子性を担保する: (1) nonce は**one-shot 消費**（`approvals.take(nonce)` = 同期的に get + delete してから async 処理に入る。2 度目の押下は payload 不在で inert。単一プロセス・JS 単一スレッドなので take は atomic）、(2) `CronJobsRepository.create()` 内で**ユーザ/guild 件数チェック（非終端 `pending`/`running`/`paused` のみカウント） + INSERT を単一 `BEGIN IMMEDIATE` txn**にまとめる（count と INSERT の間に別承認が割り込めない＝上限の TOCTOU を閉じる）。承認前の再チェックは fail-fast 用で、最終不変条件はこの take + txn が担保する。
- **承認状態の保持と再起動耐性（v1）**: 承認待ちは**承認マネージャのメモリ内のみ**で保持し、`pending_cron_approvals` のような永続テーブルは持たない（実装単純化）。よって bot 再起動でマネージャ内の payload は失われ、残存ボタンを押しても nonce が見つからず**何も起きない（inert に応答）**。custom id には job 全文を載せず短い nonce のみとし（custom id 100 字制限・payload 漏洩回避）、payload はマネージャ側に紐付ける。グローバルコンポーネントハンドラは未知 nonce を「期限切れ/失効」として inert 応答する。再起動後はユーザに `/cron add` 再実行を促す（Open Questions「承認カードの有効期限」と同根）。

### `create_cron_job` client tool の契約

[tool-calling-foundation](../tool-calling-foundation/design.md) の `IClientTool` として実装し、`ToolRegistry.register()` で登録する。基盤の handler 契約（`handler(args, ctx, signal, meta): Promise<{ llmResult: string; render? }>`・`validate`・`isEnabled`）に厳密に従う。**この tool は DB に INSERT しない**（承認カードを描画し、Approve 経由でのみ登録される。下記）。

- `name`: `"create_cron_job"`。`description`: 「定期/単発の LLM タスクの**登録を提案**する（自動登録はしない・承認が必要）」と明記し、モデルに即時副作用がないことを伝える。
- `parameters`（JSON Schema）: `{ name, schedule, prompt, channel?, once?, timezone?, model?, silent? }`。`schedule` は自然言語/cron/ISO/インターバルのいずれかを受ける文字列、`once` は単発フラグ（省略時は schedule から kind 推定）。`silent?` は `/cron add` の `silent?` と同義（`deliver_silent` に保存・既定 false）。`timezone?` は IANA tz の明示指定で、`/cron add` の `tz?` と**同一の precedence・検証**（明示 > guild 設定 > `CRON_DEFAULT_TZ` > `UTC`）に乗せる。`model?` は `/cron add` の `model?` と同義（非 NULL = 登録時スナップショット固定、省略 = 動的デフォルト解決）。cron/interval は `expr` 自体が tz を持たないため、tool 経路でも明示 tz を運べないと guild/既定 tz へ暗黙フォールバックしてしまう点を防ぐ（解決 tz は承認カードに必ず表示）。
- `isEnabled(ctx)`: 次を全て満たすときだけ true（false なら基盤が tool を提示せず、dispatch 時にも再評価して error 結果にする）:
  - `CRON_ENABLED === true`。
  - **`ctx.guildId !== null`**（`cron_jobs.guild_id` は NOT NULL・DM 非対応のため、DM/guild 外コンテキストでは tool 自体を無効化する）。
  - `ctx`（`{ guildId, channelId, userId }`）の userId が cron 登録権限を持つ（権限機構。暫定 `ManageGuild` or 本人 scope）。
- `validate(args)`: 引数の存在/型を runtime 検証（`{ ok:true, value } | { ok:false, error }`）。**スケジュールの厳格検証・正規化（kind/expr/tz 確定、下限/tz/過去拒否）はここでは完結させず**、承認カード生成側の `validateSchedule()` に委ねる（コマンド経路と完全に同一の検証関数を共有し、tool/コマンドで挙動を一致させる）。自然言語 schedule の cron/ISO 変換も同経路。
- `handler(args, ctx, signal, meta)`: スケジュール正規化 + 検証を行い（失敗時はその理由を `llmResult` の error 文字列で返してモデルに再考させる）、成功時は**承認カードを `render` で返すだけ**で INSERT しない。`llmResult` には「承認待ちカードを提示した（ユーザの Approve 待ち）」旨の短い文字列を返す（モデルが「登録済み」と誤認しないように）。承認 payload は承認フロー同様メモリ側に nonce で紐付け、Approve で初めて `CronJobsRepository.create()`。`signal` は正規化中の長い処理（LLM 変換を別途呼ぶ場合）に通す。
- tool 経由でも `/cron add` 経由でも、**最終的な検証・上限・権限/scope 再チェック・INSERT は同一の承認 → `create()` 経路に集約**する（登録の単一窓口）。

### コマンド設計

```text
/cron add        ... 承認後に登録（schedule/prompt/name/channel?/tz?/model?/silent?）
/cron list       ... 自分（or 権限者は guild 全体）のジョブ一覧（次回実行・状態。failed/done も表示）
/cron pause <id> ... status='paused'、next_run_at=NULL（pending/running に適用可）
/cron resume <id>... status='pending'、next_run_at=computeNextRun(now)（paused 専用。null なら拒否。fail_count/stale_count リセット）
/cron run <id>   ... 即時 1 回実行（スケジュールは変えない）
/cron remove <id>... 削除（任意状態で可）
```

- **`status` ごとの操作可否**:

  | status | pause | resume | run | remove | 説明 |
  | ------ | ----- | ------ | --- | ------ | ---- |
  | `pending` | ○ | × | ○※ | ○ | 通常稼働中。※ due（`next_run_at<=now`）なら手動 run は claim 経路で due スロットを消費（下記）、未 due ならスロット非変更のアドホック実行 |
  | `running` | ○ | × | ×（実行中拒否） | ○ | in-flight 1 回は完走しうるが以降は止まる |
  | `paused` | × | ○ | ○ | ○ | resume で再開 |
  | `done` | × | × | ○ | ○ | 完了済み（once 完了 / 取りこぼし）。run で手動再実行のみ可 |
  | `failed` | × | ×（**resume 不可・終端**） | ○ | ○ | 実行失敗で終端。再スケジュールは `/cron run` での手動実行 or `/cron add` 再作成に限る |

- `failed` を `resume` で `pending` に戻さないのは、失敗の根本原因（壊れたプロンプト/権限）が未解決のまま再スケジュールされるのを避けるため。`fail_count` 閾値超えの自動 `paused`（恒常失敗の保護停止）とは区別する（自動停止は `paused` なので `resume` で再開可能）。
- **`resume` の null ガード**: `resume` は `computeNextRun(now)` を計算するが、**戻りが `null`（発火時刻を過ぎた `once` / 今後一致スロットの無い `cron` 式）なら `pending` 化しない**。`pending` + `next_run_at=NULL` は `selectDue`（`status='pending' AND next_run_at<=now`）に二度と拾われず**永久に動かない stuck** になるため。null のときは resume を**拒否**して「今後の発火スロットが無い」旨を提示し（`paused` のまま据え置き）、ユーザに `/cron remove` or `/cron add` 再作成を促す（once は instant が過去、cron は式が exhausted）。
- **`resume` のカウンタリセット**: 成功した `resume`（null ガード通過 → `pending` 化）は **`fail_count` / `stale_count` を 0 にリセット**する。`fail_count >= CRON_MAX_FAILURES` で自動 `paused` になったジョブを、リセットせず resume すると次の 1 回失敗で即再 `paused` し「再開した」体験にならないため、resume を**明示的なリトライ予算の付与**と定義する（ユーザが原因を是正した想定。是正できていなければ再び閾値到達で自動停止する）。上限カウントは非終端のみなので resume 自体は count-neutral（上記「上限」Decisions）。

- `/cron run <id>` の経路は **2 ケースに分かれる**（手動実行で定期ジョブのスロットを進めたり once を消費したりしない、という原則は維持しつつ、**スケジュール済みの due スロットと手動実行の二重発火を防ぐ**ため）:
  - **`status='pending'` かつ `next_run_at <= now`（既に due）**: このジョブは次ティックで claim・発火する。手動実行を「別パス（スケジュール非変更）」で重ねると、手動 1 回 → 直後にティッカーが due スロットをもう 1 回 = **near back-to-back の二重配信**になる（DB 上の at-most-once は守られるが、ユーザ体験上は二重発火）。よって **due な手動実行は通常のティッカー経路（`claim`→実行→`finish`）を通し、due スロットを 1 回として消費する**（手動が claim の勝者になれば、その後ティッカーは `changes===0` で空振りし二重発火しない）。これは「手動実行はスケジュールを進めない」原則の例外ではなく、「既に来ているスロットを今すぐ消化する」操作として定義する。
  - **`status` が due でない（`pending` だが `next_run_at > now`、`paused`、`done`、`failed`）**: claim/finish を**通さない**別パスにし、`resolveSendable` + `runScheduledJob` + `deliver` だけを呼び、`next_run_at` / `status` / `kind=='once'` の done 化 / `fail_count` を**書き換えない**（純粋なアドホック 1 回実行。スロットを進めず once も消費しない）。claim_id が無いため `deliver` には `shouldSend = () => repo.exists(job.id)`（実行中 remove で停止）を渡し、`isStillRunning`（`running` 前提）は使わない。preflight/LLM/配信の各外部 await は scheduled 同様 timeout で囲む。**`done`（完了済み once / 取りこぼし）への手動 `run` が何度でも可能なのは意図的**: `status` は**スケジュール上の終端**を表すだけで、アドホック手動実行（スロット非消費・状態非変更）はスケジュール状態から分離する。手動 `run` は `done`/`once` の「単発スケジュールは再点火しない」不変条件を破らない（`next_run_at`/`status` を一切書き換えないため、再実行で `once` が再スケジュールされることはない）。
  - **二重実行ガード（同時起動）**: 別パス（アドホック）は claim/finish を経ないため、ティッカーが同ジョブを `running` 化している最中に走ると二重投稿しうる。よって `/cron run` は対象の現 `status` を読み、**`running` なら拒否**（「実行中です」）。さらに v1 でもプロセス内の per-job in-flight set（mutex `jobLocks`）で手動実行とティッカー実行の同時起動を弾く（単一プロセス前提なので in-memory で十分）。due ケースの claim 経路も同じ `jobLocks` を取得してから claim する。
- `<id>` は DB の `id`。`pause`/`resume`/`run`/`remove` は権限機構（暫定: 本人のジョブ or `ManageGuild`）で対象 scope を絞ってから操作する。
- **`CRON_ENABLED=false`（無効化）時のコマンド挙動**: 起動時リカバリ/fast-forward/ティッカー/sweeper が一切走らない（上記 `src/index.ts`）のと整合させ、コマンドも入口で振り分ける。**拒否（「cron 機能は無効です」と応答）**: `/cron add` と承認 Approve・`/cron resume`・`/cron run`（= 新規登録・再開・手動実行＝スケジューラ停止中に DB を `pending` 化したり手動 LLM 課金を走らせる経路）。**許可**: `/cron list`（参照のみ）・`/cron pause`・`/cron remove`（稼働を増やさない停止/削除）。これにより無効化中の bot が `running`/`next_run_at`/新規行で DB を活性化させず、再有効化時に通常の起動時リカバリで回収できる。`create_cron_job` tool は `isEnabled` が `CRON_ENABLED===true` を要求するため無効時はそもそも提示されない。
- **`running` 中の pause/resume/remove**: `pause`/`remove` は `status='running'` の行にも適用できる（ユーザが暴走中ジョブを止められる必要がある）。整合は実行側の条件付き `finish`（`WHERE status='running' AND claim_id=?`）が担保する: ユーザが先に `paused`/削除へ遷移させれば、後続の `finish`/`onFailure` は `changes===0` で no-op する。**外部 pause/remove が勝ち、in-flight 実行の後追いの success/failure 会計（`next_run_at` 前進・`status` 遷移・`fail_count` 加減）は一切反映しない**（`fail_count` も変えない）。
  - 帰結として、**in-flight 実行が成功投稿した直後に `paused` のまま留まる**（投稿はされたが完了会計は反映されない）ケースが起きうる。これは v1 で**明示的に許容**し、`/cron list`・`/status` は「`paused`（直近実行は手動停止により会計未反映）」と分かる表示にする。会計を厳密にしたい場合の発展案として、`pause` を即時 `paused` 化ではなく **`cancel_requested` フラグ**にして「現在の実行は完走・会計し、次回からスケジュール停止」とする方式があるが、v1 では複雑さ回避のため採らない。
  - `resume` は `paused` 専用（`running` には適用不可エラー）。

## Tasks

- [ ] `croner` 依存追加（v10）
- [ ] `cron_jobs` テーブル + repository（v1 は全列込みで新規 `CREATE TABLE`＝既存行なし・スキーマドリフト無し〔将来の列追加は `DEFAULT` 付き or nullable+backfill〕。全 INSERT は `create()` 集約〔**ユーザ/guild 件数チェック + INSERT を単一 `BEGIN IMMEDIATE` txn** で上限 TOCTOU を閉じる〕・`selectDue`・原子的 `claim`〔`status='pending' AND next_run_at<=?`、`claimed_at`/`claim_id` 払い出し〕・条件付き `finish`/`onFailure`〔`WHERE status='running' AND claim_id=?`、`running` を抜ける際 `claimed_at`/`claim_id` を NULL クリア、成功完了は `fail_count`/`stale_count` を 0 リセット〕・`isStillRunning(id, claimId)`〔claim_id 突合〕・`exists(id)`〔ad-hoc 配信の `shouldSend` 用〕・**stale `running` 行 SELECT**〔`selectStaleRunning(threshold)`／起動時は全 `running`〕 + パラメータ化した status 遷移書き込み〔`pending`/`paused`/`done`/`failed` と `next_run_at`/`last_run_at`/`stale_count`/`fail_count` は cronService が算出して渡す〕・件数集計）。**kind 別の復旧オーケストレーション〔fast-forward・閾値 `paused`・`jobLocks` 除外・通知〕は repository ではなく cronService**（下記）
- [ ] `chatService` 拡張: ジョブ実行用に `model?` / `systemPrompt?` / `signal?` を受ける非 stream 経路（cron が `defaultModel` 固定の現シグネチャに縛られず、timeout で OpenRouter fetch を abort できるように）+ `OpenRouterClient.chat()` に `signal?: AbortSignal` を追加（現状 `chat()` は signal 非対応で `chatStream` のみ）
- [ ] `cronService`: schedule 正規化/検証（**NL→schedule は専用 `normalizeCronProposal`〔決定的分類優先・NL のときのみ単発 non-stream/tool 無効/会話文脈なし LLM・`runToolLoop`/session 履歴 非依存〕→ 共有 `validateSchedule()` に集約**、cron は croner try/catch・kind 別下限〔cron は最低 N occurrences 列挙で最小隣接間隔を絶対 ms 判定・horizon 安全網・best-effort〕・once は厳格 ISO〔offset 必須・UTC 化・暦上ありえない日時拒否〕・全 kind の tz 検証・tz precedence）、`computeNextRun`（interval=完了基準）、`belowMinCronInterval`（cron 専用）実行時下限ガード〔claim 後・LLM 前に cron の発火スロット→次スロット実 ms 差が下限未満なら LLM を呼ばず `paused`+通知〕、fast-forward〔未発火 once/cron→`done`〕、`resolveSendable` preflight（fetch reject 内部 catch）、`runScheduledJob(job, signal)`（新規 `messages` 配列〔conversation-context の session/turn 非作成〕 + guild/channel system prompt + model 解決〔NULL=動的〕 + `CRON_JOB_TIMEOUT_MS` で abort）、`deliver`（各チャンク前に `shouldSend()` 述語再評価〔scheduled=`isStillRunning(id,claimId)` / ad-hoc=`exists(id)`〕 + 2000 字分割〔最大 `CRON_MAX_DELIVER_CHUNKS`・超過は切り詰め〕 + チャンクごと `CRON_DELIVER_TIMEOUT_MS` + 1 チャンク目成功で success 会計）、`[SILENT]` 判定〔`deliver_silent=1` のとき system prompt に規約注入 + 応答が `[SILENT]` のみなら配信スキップ〕、共有 `jobLocks` mutex、`onFailure`（`fail_count` 加算・閾値 paused・通知）、**stale 復旧 + 起動時リカバリのオーケストレーション**〔repository の stale-row SELECT + claim-conditional/パラメータ化 status 書き込みを使い kind 別分岐: 定期=`stale_count`++・閾値 `paused`・recovery 段で `computeNextRun(now)` を評価し未来スロットあり→`pending`+その slot〔`last_run_at=claimed_at`〕/`null`(exhausted)→**終端 `failed`**（attempted=結果不明なので未発火 `done` と区別）／`once`=終端 `failed`、現プロセス `jobLocks` 保持中は除外、`notifyOwner`〕
- [ ] `src/index.ts`: DI 配線 + 起動時に `cronService` の起動時リカバリ（kind 別: 定期 `running`→`pending` / `once` `running`→終端 `failed`、常駐 sweeper と同一ロジック）+ generic fast-forward（**もともと `pending` だったジョブのみ**＝`next_run_at < now` の未発火を前進。復旧した定期は recovery 段で確定済みなので対象外）を呼ぶ + 60s ティッカー（先頭で `cronService` の sweeper）+ **bounded な `shutdown`**〔`shuttingDown=true` → `clearInterval` → in-flight `AbortController` 発火 → grace timeout まで tick unwind を await。shutdown 起因 abort は `onFailure` に通さず（`fail_count` を汚さない）行を `running` のまま残し、次回起動時 stale 復旧に委ねる（定期→`stale_count`++ + 前進〔exhausted→`failed`〕／`once`→`failed`）。「graceful で `running` ゼロ」は best-effort（in-flight を跨いだ 1 本は stale 復旧で回収）。Discord `send` がキャンセル不能で in-flight な場合は遅延着弾を許容しログのみ、と明記〕（リカバリ/sweeper の実体は cronService、index は配線と起動/停止のみ）（`CRON_ENABLED=false` 時は cron state を一切変更せず recovery/fast-forward/ticker/sweeper を全て起動しない）
- [ ] `/cron` コマンド群 + 承認ボタン（**共有 in-memory 承認マネージャ + グローバル `interactionCreate` コンポーネントハンドラ**〔nonce custom_id 振り分け・`awaitMessageComponent` 非依存〕・期限 sweep による default-deny timeout・メモリ内承認状態〔再起動で inert・未知 nonce は inert 応答〕・上限チェック・`silent?` オプション → `deliver_silent`・Approve 時に scope/権限/上限/検証 + **配信先チャンネルの guild 帰属（`channel?` override がジョブ `guild_id` と一致）・当該チャンネルの bot 送信権/登録者の登録権**を再チェック・本人ジョブ scope）。`/cron run` は **due（`pending` かつ `next_run_at<=now`）なら claim 経路で due スロットを消費、未 due ならスケジュール非変更のアドホック別パス**（`running` 拒否 + 共有 `jobLocks`、二重発火防止）。status 別操作可否（`resume` は `paused` 専用、`failed` は終端）に従う。`CRON_ENABLED=false` 時の入口振り分け（add/Approve/resume/run 拒否・list/pause/remove 許可）
- [ ] `create_cron_job` client tool（[tool-calling-foundation](../tool-calling-foundation/design.md) の `IClientTool` 契約に準拠: `parameters`〔`silent?` 含む〕/`validate`/`isEnabled`〔`CRON_ENABLED` + `ctx.guildId!==null` + 権限〕/`handler(args,ctx,signal,meta)→{llmResult,render}`。即登録せず承認カードを `render`、INSERT は承認 → `create()` 経路に集約）
- [ ] 環境変数（`CRON_*`：timeout/`MAX_FAILURES` 含む）+ `envVars.ts`
- [ ] `/status` に cron 機能状態（有効・登録数）を表示
- [ ] テスト（schedule 正規化/検証・cron 下限〔最低 N occurrences 列挙で非一様式の後続隣接も検出・horizon 安全網〕・実行時下限ガード〔登録すり抜けクラスタが claim 後・LLM 前に `paused`＝無 LLM 課金〕・厳格 ISO/offset 必須/暦上ありえない日時拒否〔`2025-02-30` 等〕・offset 無し `once` 拒否・全 kind tz 検証・nextRun 境界一致・interval 完了基準で長時間実行が連投しない・claim 原子性〔due 条件込み〕・claim_id 突合で横取り後の遅延 finish/配信が no-op・条件付き finish が外部 pause を復活させない・isStillRunning(id,claimId) による remove 後の送信抑止・起動時リカバリ〔kind 別: 定期=未来スロットあり→`pending`+fast-forward・exhausted→終端 `failed` / `once`=終端 `failed`〕 + 常駐 sweeper〔現プロセス jobLocks 保持中を除外・定期=未来スロット→fast-forward/exhausted→`failed` / stale once=failed〕・**未発火 `pending` の fast-forward 枯渇〔once/cron→`done`〕は recovered〔attempted〕とは別経路で `done`**・実行失敗の once=failed〔CRON_MAX_FAILURES=1 でも paused でなく failed・終端・resume 不可〕/定期=前進・**定期 onFailure で `next===null`（exhausted）が `failed` 終端〔done=正常完了ではない・pending+next_run_at=NULL の stuck にならない〕**・`fail_count` 閾値 paused〔resume 可〕・notifyOwner throw が tick を壊さない・LLM signal abort + 配信 timeout→onFailure・上限〔承認直前再チェック〕・**Approve 時の権限/scope 失効で INSERT 拒否**・`create_cron_job` tool が DM/guildId=null で `isEnabled=false`・[SILENT]・sendable preflight が LLM を呼ばない・手動 run と ticker の共有 mutex 排他・**due 手動 run が claim 経路で二重発火しない**・preflight 失敗で `continue` 後続継続・`running` 離脱時に `claimed_at`/`claim_id` を NULL クリア・**`resume` の null ガード〔過去 `once`/exhausted `cron` の resume を拒否し stuck を作らない〕**・**stale 定期復旧で exhausted cron が終端 `failed`〔`done` ではない＝attempted/結果不明・`pending`+`next_run_at=NULL` の stuck にもならない〕 + 復旧時 `last_run_at=claimed_at`**・**分割配信の partial 成功〔chunk1 成功で success 会計・chunk2 失敗で `fail_count` 増やさない・`onFailure` に落とさない〕・各チャンク前の `isStillRunning` 再確認で pause/remove 後の後続チャンク停止**・**`create_cron_job`/`/cron add` の `timezone?`/`model?` が同一 precedence/検証で解決〔`model` 非 NULL=固定・省略=動的〕**・**stale 復旧の `stale_count` 閾値 `paused`〔`fail_count` と別カウンタ・成功完了でリセット〕**・**Approve の原子性〔二重押下/並行 Approve で nonce one-shot take + `create()` の `BEGIN IMMEDIATE` 件数チェックにより重複/上限超過 INSERT が起きない〕**・**serialized 非再入 tick〔重なり tick スキップ・長時間ジョブ後に後続が次 tick で処理〕**・**interval が 1 分整数倍以外を拒否**・**登録時 first `next_run_at` null 拒否〔exhausted cron `0 0 30 2 *`・過去 once〕**・**非ゼロ秒 cron 拒否〔6 フィールド `30 9 * * * *`・5 フィールドは許可〕**・**preflight/`notifyOwner` の timeout で tick が固着しない**・**`withTimeout` の遅延 settle が unhandled rejection を出さない**・**`silent?` → `deliver_silent` 配線〔flag 1 で system prompt 規約注入 + `[SILENT]` 配信スキップ・flag 0 で常に配信〕**・**`channel?` override の guild 帰属検証〔別 guild チャンネルは bot 送信可でも拒否・当該チャンネルの送信権/登録権を確認〕**・**起動時 fast-forward の境界一致〔`next_run_at===now` は fast-forward せず ticker が 1 回実行・`next_run_at<now` のみ前進〕**・**stale 復旧の claim-conditional 書き込み〔SELECT 後に pause/remove/横取りが入った行は `changes===0` でスキップし古い recovery が新状態/新 claim_id を上書きしない〕**・**直列 tick で後続ジョブの `claimed_at`/`last_run_at` が tick 先頭 `selectNow` でなく per-job `claimNow` になる〔stale 会計が実 claim 起点〕**・**上限カウントは非終端（`pending`/`running`/`paused`）のみ・`done`/`failed` 除外・resume は count-neutral**・**bounded shutdown〔非 in-flight 時は `running` ゼロで落ちる・in-flight を跨いだ 1 本は `running` のまま残し起動時 stale 復旧で回収・shutdown 起因 abort は `onFailure` に通さず `fail_count` を汚さない〕**・**stale `running` 復旧の exhausted 定期は `done` でなく終端 `failed`〔claim 済み=結果不明・未発火取りこぼし `done` と区別・recovery 段で決定し generic pending fast-forward に渡さない〕**・**`resume` が `fail_count`/`stale_count` をリセット〔自動 paused 後の resume が次 1 回失敗で即再 paused しない〕**・**分割配信の途中チャンク失敗で残りを停止しつつ success 会計維持**）
- [ ] README AUTO セクション再生成（コマンド一覧 + 環境変数）
- [ ] `docs/changes/cron/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **連続失敗時の登録者通知 UX**: 自動停止ロジック（`fail_count >= CRON_MAX_FAILURES` で `paused`）は確定。残るのは**通知先**: bot は DM intent を持たないため登録者 DM は不可。元チャンネルにメンション付きで通知するか、停止だけしてサイレントにするか（`/cron list` の状態表示で気付かせる）が未確定。
- **配信先チャンネルの権限喪失**: bot が channelId に送信権を失っている / チャンネル削除済みの場合は `resolveSendable` の preflight で検知 → `onFailure`（LLM 未呼び出し）。閾値で `paused` 化される。残課題は上記の通知 UX。
- **タイムゾーン入力**: precedence（明示 > guild 設定 > `CRON_DEFAULT_TZ` > `UTC`）と承認カードでの明示表示は確定（Decisions 参照）。残るのは guild 既定 tz を `settings-hierarchy` のどの粒度（guild/channel）に置くか、`CRON_DEFAULT_TZ` の運用既定値（`UTC` か運用者ローカルか）のみ。
- **`once` の壁時計→instant 変換（v1 で延期）**: v1 は `once` に offset 付き ISO を必須化し、壁時計 + IANA tz の絶対化は LLM 整形に委ねる（Design「スケジュール正規化・検証」）。将来サーバ側で壁時計→instant 変換を入れるなら、DST gap（存在しない時刻）/fold（二重に存在する時刻）の解決ポリシー（gap は前進/後退どちらに丸めるか、fold は earlier/later どちらを採るか）を明示し、`Temporal` 等の DST-aware 変換を使う必要がある。
- **多重起動 / stale `running` 復旧**: v1 は単一プロセス想定で、(a) 起動時に `running` を一括 `pending` に戻す（起動時リカバリ）+ (b) 毎 tick 先頭で `claimed_at` が古い `running` を戻す常駐 sweeper、で固着を回収する（上記「実行ハング対策」）。多重起動を許す場合は起動時の**一括**戻しが他プロセスの実行中ジョブを誤って戻すため、起動時も `claimed_at` ベースの time-boxed 判定に変え、かつリーダー選出が要る。v1 ではスコープ外。
- **取りこぼし/結果不明 one-shot の可視化**: `once` の終端は 2 系統ある — (a) ダウンタイムで発火時刻を過ぎ未発火のまま fast-forward された場合は `done`（back-run しない・`last_run_at=NULL`）、(b) `running` のままクラッシュ/ハングで stale 復旧された場合は `failed`（結果不明・`last_run_at=claim 時刻`）。v1 は `last_run_at` の有無で取りこぼしと結果不明を区別できるが、「成功 done」「取りこぼし done」「結果不明 failed」を厳密に分けたいなら将来 `missed`/`unknown` ステータスを足す。
- **承認カードの有効期限**: ボタン timeout 後の再登録 UX（`/cron add` 再実行）。
- **LLM 整形の品質**: 曖昧依頼から作る自己完結プロンプトが意図とずれるリスク。承認画面で全文提示するため、ユーザが確認・却下できることを前提とする。

## 参照

- [croner](https://github.com/hexagon/croner) — Bun 対応・依存ゼロ。本設計では **`cron` の `new Cron(pattern, { timezone })` + `nextRun(fromDate)`（strictly after）にのみ使用**。IANA tz / DST 対応・不正パターンは構築時 throw。`once` は croner の one-shot API（`new Cron(date)` + `getOnce()`）を使わず独自に厳格 ISO 検証 + UTC instant 保存（理由は Decisions「スケジューリングライブラリ」）
- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/reference/chat) — ジョブ実行は新規 `messages` 配列での単発 completion
- [discord.js Channels](https://discord.js.org/docs/packages/discord.js/main) — 配信先は `client.channels.fetch(id)` → `isTextBased()` + `isSendable()` でガードしてから `send`（テキストチャンネル/スレッド両対応・`null`/非送信可チャンネルを弾く）。特定クラスの `send` シグネチャに限定しない
- 着想元: hermes-agent の cron 機能（ユーザ文そのまま・承認なし・LLM 自動登録可）を、自己完結プロンプト整形 + 承認ゲートで改良
