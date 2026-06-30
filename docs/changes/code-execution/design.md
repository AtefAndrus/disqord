---
title: "コード実行（microsandbox 統合）"
status: planned
priority: medium
summary: "microsandbox による安全なコード実行（/run・LLM tool 統合）"
---

# コード実行（microsandbox 統合）

## Why

LLM はコードを書けるが実行できないため、計算結果の検証・データ可視化・ライブラリ挙動の確認といった「書いて動かして観察する」フローを Bot 内で完結できない。ユーザは別環境にコピペして実行する手間を強いられ、対話の流れが切れる。

[microsandbox](https://github.com/superradcompany/microsandbox) を使い、LLM の tool call と `/run` スラッシュコマンドの両方から microVM 上でコードを実行できるようにする。microVM によるハードウェア隔離と smoltcp ベースの default-deny egress により、ホスト側に追加のセキュリティ機構を実装せずに untrusted コード実行を許容できる。

LLM tool call の protocol 部分（streaming delta 蓄積・`role:"tool"` 整合・マルチターン制御・timeout/cancel）は本 change では持たず、[tool-calling-foundation](../tool-calling-foundation/design.md) の `runToolLoop()` / `ToolRegistry` に委ねる。本 change の責務は **`execute_code` / `execute_code_with_network` の 2 tool（スキーマ + 検証 + sandbox 実行ハンドラ + Discord 描画）を foundation に登録すること**に絞る。

## 依存 / 関連 change

- 先行: [tool-calling-foundation](../tool-calling-foundation/design.md) — client tool calling 基盤（`IClientTool` / `ToolRegistry` / `runToolLoop()`）。本 change の 2 tool はここに登録する**最初の利用者**。streaming tool ループ・id 整合・暴走防止（`MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN`）・timeout/cancel の `AbortSignal` 配線・空 tool omit は **すべて foundation 側**にあり、本 change では再実装しない
- 連携: [chat-response-v2](../chat-response-v2/design.md) — tool 実行中の進捗（「コード実行中...」）と最終応答 stream は foundation 経由で V2 の streaming updater を利用。本 change は tool 結果の描画断片を `render`（foundation 契約では `ToolRenderPayload`、現状 updater が解釈する**不透明な payload**）として返す。**ただし本 change は `render` が attachment-capable かつ mention-safe（V2 components + 添付ファイル payload + flags + `allowedMentions`、下記「Discord 出力整形ルール」の `ToolRenderPayloadShape`）であることを upstream 契約への要件として surface する**（生成画像/ファイルを運ぶため必須。foundation/chat-response-v2 がこの shape を採用しているか Phase C で確認・未対応なら反映依頼。Risk「`tool-calling-foundation` への依存」参照）
- 関連: [conversation-context](../conversation-context/design.md) — 将来の per-conversation persistent sandbox は同 change の `session_id` をキーにできる（**sandbox の所有・ライフサイクルは本 change 側**。詳細は Non-Goals の「将来別 change 候補」参照）

## Goals / Non-Goals

**Goals:**

- LLM tool として `execute_code({language, code})` を提供し、tool calling 対応モデルで自律的にコード実行・結果観察ができる
- デフォルト egress 禁止、ネットアクセス必要時は別 tool `execute_code_with_network` を明示的に呼ぶ設計。`with_network` 自体も guild 設定の **別 toggle** で明示有効化が必要（二段階ゲート）
- 言語 v1: `python` / `node` / `bash`。各々 OCI image (`python:3.13-slim` / `node:22-slim` / `debian:trixie-slim`)
- stdout / stderr / exitCode / 生成ファイル / 生成画像 を Discord Components V2 で整形して返す。長文 stdout は `File` 添付、ビットマップ画像 (PNG/JPEG) は `MediaGallery`、SVG / その他は `File`
- Guild 単位で機能の ON/OFF を切替可能（`code_execution_enabled` / `code_execution_network_enabled` 2 つのフラグ）
- 実装時のテスト用に `/run` スラッシュコマンドを `NODE_ENV !== "production"` 限定で提供（dev only、リリース時は未登録）
- LLM tool 経路の streaming（tool_call delta 蓄積・「コード実行中...」進捗・tool 結果受領後の最終応答 stream）は foundation の `runToolLoop()` に委ね、本 change は tool 結果の描画断片（V2 Container）を供給する

**Non-Goals:**

- **複数 exec 跨ぎでの変数・import・生成ファイル持続** — v1 は **1 tool call = 新規 sandbox 作成 → exec → 破棄** の per-call lifecycle。「会話文脈下での persistent sandbox」（long-lived REPL kernel）は将来スコープで、**所有・ライフサイクルは本 change（code-execution）側**が持つ。[conversation-context](../conversation-context/design.md) が提供する `session_id` を sandbox のキーにできるが、sandbox の生成/破棄/TTL/孤児掃除を担うのは本 change（下記「将来別 change 候補」参照）
- カスタム OCI image のユーザ指定 UI（v1 は固定 3 言語）
- pip / npm の永続パッケージ管理（毎回 fresh image、必要なら sandbox 内で `pip install` を含むコードを書いてもらう想定）
- GPU sandbox（microsandbox 自体が現状サポートしない）
- LLM tool call 時のユーザ事前承認ボタン（per-execution HITL approval）。封じ込めは microVM sandbox が担うため、承認ゲートは封じ込めの代替にならず不要（理由は Decisions「Tool call の承認モデル」参照。default-deny egress + per-guild 2 段階 toggle が承認境界）
- 永続ボリューム / 会話跨ぎのファイル共有
- `/run` の production 公開（dev only）
- 既存の `chat-response-v2` change（別途進行）との V2 builder 統合最適化 — 両者で V2 component を組むが、code-execution の output と chat-response の text stream は構造が大きく異なるため、共通 primitive は最小限（`buildErrorContainer` 等）に留め、それぞれ独立の builder を持つ

**将来別 change 候補:**

- **per-conversation persistent sandbox**（会話文脈下で変数・import・生成ファイルが持続する long-lived sandbox）→ 別 change。**所有・ライフサイクルは本 change（code-execution）系**で、[conversation-context](../conversation-context/design.md) の `session_id` をキーに sandbox を引き当てる。`sandbox_sessions` テーブル・TTL sweeper・LRU 強制停止・起動時孤児検出は **この将来 change で初めて必要**になる（v1 の per-call lifecycle では構造的に不要）。conversation-context は session_id を提供するだけで sandbox を所有しない
- モデル選定 UI の tool calling 絞り込み（`GET /api/v1/models?supported_parameters=tools` で `/model` choices を動的フィルタ）→ 別 change `model-selection-tool-filter`
- LLM チャット返信の Components V2 化 + 進捗表示インフラ → 既存 `chat-response-v2` で対応
- 設定 SSOT 化（envVars.ts を SSOT 化 + CLAUDE.md AUTO 生成）→ 別 change `default-model-ssot`
- Re-run button / Regenerate UI → 別 change（ephemeral in-memory store (TTL 短め) + per-user opt-in。コード本体保存がプライバシー方針と矛盾するため v1 不可）
- L2/L3 boost level に応じた `SANDBOX_FILE_MAX_BYTES` 自動上書き → v1.1
- 画像超過時の zip 化（bitmap > 10 枚 + その他多数）→ v1.1（v1 は個別 `File`）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| tool calling の実装 | [tool-calling-foundation](../tool-calling-foundation/design.md) に **`IClientTool` として 2 tool を登録**（`execute_code` / `execute_code_with_network`）。本 change は streaming ループ・id 整合・暴走防止・空 tool omit を持たない | protocol まわり（delta 蓄積・`role:"tool"` 整合・`MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN`・timeout/cancel 配線）は複数 tool 機能で共有すべき横断関心で、foundation が一手に引き受ける。本 change は「スキーマ + `validate` + sandbox 実行 `handler` + 描画」だけを差し込む |
| サンドボックス実装 | microsandbox | microVM ハードウェア隔離 + smoltcp ユーザ空間ネット (TUN 不要、LXC 親和性◯) + default-deny egress。Piston/Judge0 はホスト型で security profile が弱い |
| デプロイ形態 v1 | Bot コンテナ同居（**Deploy-Plan A**） | 最短検証ルート。`/dev/kvm` を 3 層（Proxmox LXC → Docker → Bot コンテナ）でパススルー。失敗時は **Deploy-Plan B**（別 VM + HTTP wrapper）に退避。**Deploy-Plan A/B はデプロイ方式の選択肢**で、実装フェーズ（Phase 0/A/B/C/D、下記 Tasks）とは別軸の命名 |
| Bot ベースイメージ | `oven/bun:1-debian`（ただし glibc バージョン要確認） | microsandbox は **glibc 2.39 以上**を要求（`scripts/install.sh` の `LINUX_GLIBC_MIN_VERSION="2.39"`。Linux バンドルが Ubuntu 24.04/glibc 2.39 でビルドされるため）。Alpine/musl 不可。`oven/bun:1-debian` は Debian **bookworm**（glibc 2.36）ベースで **2.39 未満の可能性があり Phase 0 で要確認**。不足なら `ubuntu:24.04` + Bun 手動インストールのカスタム Dockerfile、または glibc 2.39+ を含む newer な debian/trixie タグへ切替 |
| イメージキャッシュ | コンテナ内の固定パス (`/data/microsandbox/`、`MSB_HOME` 環境変数で指定) を Docker named volume にマウント。Bot 起動時に 3 言語 image を **prewarm**: 各 image で `Sandbox.builder("prewarm-" + slugify(img)).image(img).create()` → `stopAndWait()` → `removePersisted()` を 1 回ずつ実行することで image layer を pull + cache（prewarm sandbox 自体は残さない） | 再起動毎の image pull を回避し、初回 tool call の応答時間を sandbox boot (~100ms) のみに。NAPI SDK には `Image.pull()` のような直接 API はない（`Image` クラスは get/list/inspect/remove/gc のみ）ので create-then-stop で代用。pull 完了を確実に検知したい場合は `Sandbox.builder(...).createWithPullProgress()`（レイヤ単位の進捗を返す）を使う選択肢もある。sandbox name は許容文字に制限がある可能性があるため `python:3.13-slim` のような image 名は `:` `/` を `-` に置換した slug を使う (例: `prewarm-python-3-13-slim`)。実 API の name 制約は Phase A の verify task で確認 |
| Sandbox name 採番 | per-call で `exec-${crypto.randomUUID()}` (collision-proof な短縮 ID) | microsandbox の Sandbox は name 必須、同時実行で衝突しないために UUID ベース |
| Sandbox ライフサイクル | **per tool call**: `Sandbox.builder(name).image(img).cpus(1).memory(512).create()` → `exec(cmd, args)` → 結果収集 (下記の fs read) → `stopAndWait()` を 1 リクエスト内で完結。permanent storage / detached なし | 「会話跨ぎで変数・import が持続」は **複数 exec 跨ぎで long-lived REPL kernel が必要** で v1 にはオーバーキル。persistent sandbox は将来別 change（**所有は本 change 系**、[conversation-context](../conversation-context/design.md) の `session_id` をキーに引き当て）で扱う |
| Sandbox リソース上限（disk 含む） | CPU `cpus(1)` / RAM `memory(512 MiB)` を builder で指定。**disk/inode 上限は enable 前に必ず確定する**: microVM の rootfs が**有界な ephemeral disk**（固定サイズ仮想ディスク等）であることを Phase 0/A で検証し、microsandbox builder に disk 上限オプションがあればそれで bound、無ければ `MSB_HOME` を載せる Docker volume / tmpfs 側に size quota を課す | `/dev/kvm` 隔離 + memory cap だけでは **disk 枯渇 DoS** を防げない。host disk が VM rootfs を sparse backing する構成では sandbox 内の disk fill が host disk を圧迫しうる。`/tmp/out` の 50 MB cap は **host 収集量**の bound であって sandbox 内 disk fill の防止ではない（上記「`/tmp/out/*` の収集上限」の注記と整合）ので、disk bound は別途必要 |
| 結果として消える複雑性 | DB sandbox_sessions テーブル、TTL sweeper、LRU 強制停止、**DB 駆動の**起動時孤児検出、channel-level privacy concern | 全て per-call lifecycle により構造的に不要。persistent sandbox を入れる将来別 change で初めて必要になる。**ただし「クラッシュで create 後 removePersisted 前に落ちる」ことによる MSB_HOME ストレージ/リソース leak は per-call でも残る**ため、DB テーブルは持たないまま **stateless な起動時 name-prefix sweep**（`exec-`/`prewarm-` の persisted sandbox を best-effort kill/removePersisted）だけは行う（下記 Tasks）。これは sandbox_sessions のような状態管理ではなく、所有プレフィクスの掃除のみ |
| 同時起動上限 | グローバル N 個（デフォルト 4）、超過時はキューで待機。**ただし「ジョブ promise が settle したら slot を自動解放する」型の limiter（Bottleneck / `p-limit` の標準的な `schedule(fn)` 用法）は使わない**: 本設計は handler が abort で先に throw した後も permit を保持し続ける必要があり、auto-release-on-settle では orphan create を取りこぼす。代わりに **明示的な abort-aware カウンティング semaphore**（手動 `acquire()` → `release()` を返す）を実装し、`release()` は **物理クリーンアップ完了時にだけ**呼ぶ。待機 5 秒超は **sandbox を作らず `systemError.kind:"queue_timeout"` を載せた正常 `ExecResult` を返す**（throw ではない。下記「queue timeout の結果形」）。**permit は handler の return ではなく sandbox のライフサイクルに紐づける**: permit は `create()` 呼出前に `acquire()` し、**`create()` の resolve/reject と（abort/boot-timeout で handler が先に脱出した場合の）detached cleanup 完了**時に `release()` する（成功経路は teardown 完了時）。これにより「handler が abort で即 throw → 次ジョブ開始」しても、まだ生成中/後始末中の orphan VM が N にカウントされ続け、abort 連打でも実 VM 数（active + 生成中 + teardown 中）が N を超えない | per-call lifecycle 下では「古い sandbox を kill」が無意味なので LRU ではなくキュー。同時 5 件以上の負荷は v1 では受けない。これは sandbox 同時数のリソース制限で、tool call 個数/ターン暴走防止（`MAX_TOOL_CALLS_PER_TURN` / `MAX_TURNS`）とは別軸（後者は foundation 側）。permit を handler return（= limiter のジョブ promise settle）に紐づけると、create が遅延 resolve する隙に slot だけ先に空き、orphan create が積み上がって N を超えうる（下記 sandboxService の「create() への abort race」参照） |
| queue timeout の結果形 | **正常 `ExecResult`**（`systemError.kind:"queue_timeout"`）として返し、throw しない。例外は **foundation `signal` abort（request cancel / per-tool wall timeout の双方）のみ**で、これは foundation の cancellation 契約に従い throw する | キュー枯渇は「実行できなかった」想定内事象であり、`args.timeout_sec`（sandbox 内 timeout）と同じく LLM へは tool result、Discord へは red Container で一貫描画したい。`/run` と LLM tool 経路の両方で同じ整形経路に乗る。`signal` abort だけは「実行結果不明」セマンティクスのため handler が正常 `ExecResult` を返さず throw する（cancel/timeout の分類と tool 結果生成は foundation が signal 状態で行う: **request cancel は loop を止め `{status:'cancelled'}`、per-tool timeout は bounded な error tool 結果を生成して loop は続行しうる**。handler はこの分類に関与せず、ターン継続/停止は本 change が決めない） |
| 1 turn あたり tool call 上限 / ターン上限 | **foundation 側で対応**（`MAX_TOOL_CALLS_PER_TURN` / `MAX_TURNS`）。本 change では再実装しない | モデルが 1 ターンで多数の tool call を emit する暴走・tool だけ実行して回答しない宙吊りは protocol 横断の懸念で、[tool-calling-foundation](../tool-calling-foundation/design.md) のガードレールが担う。本 change の `SANDBOX_MAX_CONCURRENT` キューと相補的 |
| Tool call 実行順序 | **foundation 側で sequential dispatch**（本 change では制御しない） | parallel 実行は Discord 出力順 / sandbox queue 順 / UI block ordering を複雑化するため foundation が v1 で逐次に固定。本 change の handler は 1 call 分の sandbox 実行だけを担う |
| 実行タイムアウト（sandbox 内） | デフォルト 30 秒、tool 引数で最大 `effectiveTimeoutSecMax`（標準 clamp 下で 120）秒まで上書き可。**2 経路で kill 順序が異なる**: (A) **`args.timeout_sec` 到達（正常 timeout 結果を返したい）**= **VM 内ラッパの watchdog が user プロセスグループを kill し `$?`／`truncated` メタを flush**（host の `ExecHandle.kill()` は冗長な backstop 信号で、これに依存しない）→ ラッパ返却（backstop 内）後、**VM を壊す前に** bounded stdout/stderr + `/tmp/out` を `SANDBOX_COLLECT_DEADLINE_MS` 下で収集 → その後 `stopAndWait()`（失敗時 `sandbox.kill()`）→ `removePersisted()`。`systemError.kind:"timeout"` 入りの**部分出力を含む正常 ExecResult**を返す。(B) **foundation `signal` abort（cancel / wall timeout、結果不明 → throw）**= `ExecHandle.kill()` → **即 `sandbox.kill()`（VM 全体強制終了、収集はスキップ）**→ `removePersisted()` → throw。収集しないのは結果を返さない経路だから | 無限ループ対策 + **foundation の timeout/cancel 副作用安全性契約を満たす**（下記「Tool の timeout/cancel 契約」参照）。**(A) で `sandbox.kill()` を収集前に撃つと `/tmp/out` と capture ファイル（file-redirect 方式）が読めず空の timeout 結果になる**ため、timeout_sec 経路は必ず「process kill → collect → VM teardown」の順にする。**ただし (A) の process kill は top-level プロセスだけでなくユーザコードの*プロセスツリー全体*を止める必要がある**: ユーザが子プロセス（`subprocess` / バックグラウンドジョブ等）を spawn していると、`ExecHandle.kill()` が exec した親プロセスのみを殺す実装では収集ウィンドウ中に生き残った子が `/tmp/out` を書き換え続けたり（`_with_network` 経路では allow-list egress を継続したり）しうる。そこで bounded-capture 用の bash ラッパ（下記「stdout/stderr の bounded capture」(b)）でユーザコードを**新しいプロセスグループ**（`setsid`）で起動し、**`timeout_sec` の到達判定と group kill を VM 内のラッパ自身が行う**（`timeout(1)` 相当の watchdog で `timeout_sec` 経過時に `kill -TERM -- -<pgid>` → 短い TERM→SIGKILL 猶予〔数秒の固定値、`SAFETY_MARGIN_MS` に内包し独立 budget 項にしない〕後 SIGKILL → reap）。**kill 対象はユーザプロセスグループだけでラッパ本体は生かす**ので、ラッパが子の終了を検知して `$?`／`truncated` メタを capture ファイルへ flush でき、host はその確定後に収集できる（host が wrapper を kill すると exit メタが書かれない問題を回避し、子プロセスが収集ウィンドウ中に `/tmp/out` 書き換えや egress を続けることも防ぐ）。host 側の `args.timeout_sec` race は **`timeout_sec` + 猶予 + 小マージン以内の backstop**で、ラッパが正常に in-VM timeout を処理して返れば host は収集 → teardown するだけ、**ラッパ自体が backstop を超過したら** host が `sandbox.kill()` + 収集スキップへエスカレーションする。VM 内 watchdog による group kill + メタ flush が Phase A で確立できない場合は、**timeout_sec 経路も abort と同様に host から `sandbox.kill()` + 収集スキップへフォールバック**（部分出力を諦める）。**`ExecHandle.kill()` 自体は hang しても wall budget を食い潰さないよう短い deadline で race する fire-and-bounded**にし、独立した budget 項にはしない: (A) では in-VM watchdog の group kill はラッパ返却（backstop 内）で確定し host の収集は `SANDBOX_COLLECT_DEADLINE_MS` 窓に内包する（host の redundant `ExecHandle.kill()` が ack されなくても窓終了で collect へ進む）、(B) では **`ExecHandle.kill()` の完了を待たずに即 `sandbox.kill()` へエスカレーション**する（VM 破棄が in-VM プロセスごと確実に停止するので process-kill の ack を待つ必要はなく、killable isolation を遅延させない。`sandbox.kill()`→`removePersisted()` は `SANDBOX_TEARDOWN_DEADLINE_MS` 窓）。よって process-kill は OVERHEAD_MS の独立項にならず、隣接サブデッドライン（A=収集 / B=teardown）に吸収される。`Sandbox.kill()` と `ExecHandle.kill()` は両方 NAPI SDK に存在 ([sdk/node-ts/src/sandbox.ts:336](https://github.com/superradcompany/microsandbox/blob/main/sdk/node-ts/src/sandbox.ts) / [exec.ts:127](https://github.com/superradcompany/microsandbox/blob/main/sdk/node-ts/src/exec.ts))。`args.timeout_sec` 到達と `signal.aborted` を race で監視し、勝った方に応じて (A)/(B) の経路を選ぶ（signal 優先） |
| wall timeout budget 不変条件 | foundation の per-tool `timeoutMs` を **180 秒**にし、各オーバヘッド項を**個別に enforce された有界サブデッドライン**にする: `queue待ち ≤ 5s`（queue_timeout）/ `boot(create→ready) ≤ SANDBOX_BOOT_DEADLINE_MS(既定 20s)` / `args.timeout_sec ≤ 120s`（in-VM）/ `/tmp/out 収集 ≤ SANDBOX_COLLECT_DEADLINE_MS(既定 15s)` / `teardown(stopAndWait or kill→removePersisted) ≤ SANDBOX_TEARDOWN_DEADLINE_MS(既定 10s)`。これらの和（5+20+120+15+10 = 170s）＋安全マージン ≤ 180s を満たす（`5 + 20 + 120 + 15 + 10 = 170 ≤ 180`） | foundation の wall timeout は handler 起動時点から計時し、abort 時は handler を kill→throw（cancellation, 結果不明）に倒す。一方 `args.timeout_sec` 到達は**正常 `ExecResult`（`systemError.kind:"timeout"`）**を返したい。`timeoutMs` が `各サブデッドラインの和`より小さいと、正規の 120s 実行が**収集/teardown の途中で** wall timeout に**先取り**され、想定の正常 timeout 結果ではなく cancellation throw になってしまう。**margin を「残り全部」で hand-wave せず、boot / 収集 / teardown を個別の enforce 可能なデッドラインにする**のが要点で、これにより遅い `create()`・大量 fs read・遅い `stopAndWait()`/`removePersisted()` のいずれも 180s wall を食い潰せない（各 phase が自身のサブデッドライン超過時に **その phase 内で kill→`systemError.kind:"boot_failed"`/正常 ExecResult を返す or 有界 teardown に倒す**ため、wall timeout に到達する前に handler が自力で settle する）。収集サブデッドラインは下記 bounded enumeration/read の有界性（cap+1 列挙 + per-file bounded read）と併せて effective に bound される。130s では queue(5s)+120s で既に 125s を消費しサブデッドライン和を満たせないため不足。180s なら 170s 和 + 10s マージンで足りる（`timeout_sec` 上限を下げる手もあるが UX を優先し timeoutMs を上げる）。**foundation 依存**: foundation の `IClientTool.timeoutMs` は dispatcher が上下限で**クランプ**する契約なので、この 180s が clamp されないこと（`CLIENT_TOOL_TIMEOUT_MAX_MS ≥ 180_000`）に依存する。本 change は **単一の導出値** `effectiveTimeoutSecMax = floor((actualToolTimeoutMs − OVERHEAD_MS − SAFETY_MARGIN_MS) / 1000)` でゲートする。**`actualToolTimeoutMs = min(180_000, C)`**: tool の `timeoutMs` は `180_000` ハードコードなので、clamp 上限 C がいくら大きくても実 wall timeout は **180s で頭打ち**（C を直接使うと C=300s で 240s を導出し、実 wall 180s に収まらない誤りになるため必ず `min(180_000, C)` を使う）。C が 180s 未満なら clamp 後の実 wall = C なので `actualToolTimeoutMs = C`。**`OVERHEAD_MS` は固定定数ではなく実 config 由来**: `OVERHEAD_MS = QUEUE_WAIT_MS(5s) + SANDBOX_BOOT_DEADLINE_MS + SANDBOX_COLLECT_DEADLINE_MS + SANDBOX_TEARDOWN_DEADLINE_MS`（既定値で 5+20+15+10 = 50_000）、`SAFETY_MARGIN_MS = 10_000`。デッドライン env を変えれば OVERHEAD_MS も追従し、effectiveTimeoutSecMax が自動で縮む。**`actualToolTimeoutMs − 50s` ではなく `− 60s`**: `− 50s` だと margin がゼロになり、収集/teardown が一瞬でも延びた瞬間に wall timeout に先取りされる（例 actualToolTimeoutMs=120s で 70s 上限なら 70+50=120 で margin 0）。正しくは `actualToolTimeoutMs − 60s`（例 actualToolTimeoutMs=120s → 60s 上限、actualToolTimeoutMs≥180s〔= C≥180s〕 → 180−60 = 120s 上限＝既定と一致）。`effectiveTimeoutSecMax < 1` なら **fail closed**（feature を無効化）。この単一値（と派生する `defaultTimeoutSec = min(30, effectiveTimeoutSecMax)`）を **JSON Schema の `code/timeout_sec` の `maximum`/`default`・runtime `validate`・`/run` modal の timeout ラベル/初期値・env budget validate・docs 表記すべてで共有**し、固定の「120」「30」をハードコードしない。Phase C で **実 clamp 値 C を読み `actualToolTimeoutMs = min(180_000, C)` 経由で effectiveTimeoutSecMax を導出**する（C ≥ 180s なら 120s に落ち着く）。**C の取得経路**: foundation が export する clamp 上限定数 `CLIENT_TOOL_TIMEOUT_MAX_MS`（または同等の config 値。foundation 側に定義・export を依頼。下記 Risk「`tool-calling-foundation` への依存」(1)）から読む。foundation がこの値を露出していない場合はドキュメント化された既定 clamp 上限を使い、それも不明なら **fail-closed**（根拠のない 180s 想定を避ける） |
| prewarm readiness gate | `SANDBOX_ENABLED=true` のとき起動時に `await prewarmImages()` を**完了させてから** tool を registry に登録/expose し `/run` を受け付ける。`sandboxFeatureEnabled()`（両 tool の `isEnabled` と `/run` が参照するゲート）は **prewarm 完了フラグが立つまで `false`**。**prewarm 失敗時は v1 では feature 全体を fail-closed**（`sandboxFeatureEnabled()` を false のまま据え置き、tool を expose しない）。per-language の部分無効化は v1 では行わない（固定 3 言語 enum + tool-level `isEnabled` のため表現できない。per-language 可用性は将来 dynamic schema で）。cold な image pull を実 tool call の 180s budget に持ち込まない | 180s wall budget は **warm boot (~100ms) 前提**。prewarm 前の cold `create()` は image layer pull（初回は数十秒〜分）を含みうるため、budget を食い潰して正規実行を foundation timeout/cancel に倒してしまう。readiness gate で「image pull は起動時に完了」を保証し、実 tool call の経過時間を boot+exec+収集+teardown に限定する |
| Tool の timeout/cancel 契約 | foundation の handler 契約（timeout/cancel は「実行結果不明」セマンティクスで、副作用安全性は tool 側が **killable isolation 等で担保**）を **`sandbox.kill()` を有界に完了させる保証で満たす**。**killable isolation の本体は `sandbox.kill()`（VM 破棄＝プロセス + ネット停止）であり、`removePersisted()`（メタデータ削除）は安全境界ではない**。abort 検知時は `ExecHandle.kill()` → `sandbox.kill()` を発火し、**VM 停止が確定するまで concurrency permit を保持する**ことで「生きている VM 数・副作用」を bound する（`removePersisted()` は VM 停止後に permit 非保持の detached で best-effort。上記「teardown 超過の単一ステートマシン」(2)(3) 参照）。**重要: foundation は handler の settle/throw を待たず race で timeout/cancel を分類して結果生成・続行/停止しうる**（foundation の cancellation 契約。遅延 settle は破棄）ので、本 tool は **「foundation が `sandbox.kill()` の完了を観測してから分類する」ことには依存しない**。安全性は「kill が permit-held パスで有界に完了し、その間 slot を占有し続ける」ことから来る（foundation が先に進んでも live VM は permit で N に bound）。`sandbox.kill()` を有界に確定できない場合は契約成立を主張せず feature を degraded/fail-closed にする | foundation は「非協調的な副作用 tool は abort-aware commit / killable isolation / idempotency のいずれかを提供せよ」と要求する。本 tool は sandbox 隔離なので、`signal.aborted`（per-tool wall timeout でも request cancel でも）を検知したら VM ごと kill して副作用（プロセス・ネット）を確実に断ち切れる → killable isolation を選択。協調的な signal 確認に依存せず、microVM 破棄で結果不明な実行を物理的に停止できる。**ただし「VM を確実に破棄できる」が前提**なので、`sandbox.kill()` の有界性・確実性は Phase A 検証必須（保証できなければ enable しない） |
| 同時実行ロック (sandbox 内) | per-call なので不要 (**1 sandbox = 1 ユーザ実行**。capture/listing/collection 用の内部 control コマンド〔file リダイレクト・`find` manifest・`head -c` 等〕は teardown 前に追加実行しうるが、ユーザコードの並行実行はしない) | per-call lifecycle の副次的利点 |
| 出力上限 (host 側) | stdout/stderr 各 256 KB (`SANDBOX_OUTPUT_MAX_BYTES_HOST`)、bounded capture（streaming cap か sandbox 内 file リダイレクト + `head -c` ラッパ、方式は Phase A で確定。下記注記）で**受信時点で**上限を効かせる | host メモリ保護。**受信時点で 256 KB を効かせるのは必須**で、SDK が一括返却しかしない場合も post-hoc host truncate にはフォールバックせず、sandbox 内 file リダイレクト + `head -c` で**sandbox 内で cap してから**bounded read する（下記注記。host が一括 string を抱える方式は採らない）。Discord file attachment 上限 (`SANDBOX_FILE_MAX_BYTES`、9 MB) は別概念 (下記別行) |
| `/tmp/out/*` の収集上限 | 合計 50 MB / 最大 50 ファイル (**host 側収集・転送の上限**)、かつ **per-file は `SANDBOX_FILE_MAX_BYTES`(9MB) で bounded read**。**Discord に表示する attachment は計 10 まで** — offload した stdout/stderr・MediaGallery 画像・個別 File が**単一 budget を共有**し、優先順位は stdout/stderr offload → bitmap 画像 → その他 File（Discord API の `files: [...]` 配列上限に合わせる）、超過は warning TextDisplay で「N 件のファイルが省略されました」を表示 | host が読み取って Discord に上げる量の保護（**sandbox 内の disk fill 防止ではない**: sandbox 内 FS の使い切りは VM の memory/disk 隔離が担う。本 cap は host 側 collection を bound するもの）+ Discord attachment 上限保護。詳細は「Discord 出力整形ルール」参照 |
| ネットワーク既定 | egress 完全禁止。`SandboxBuilder.disableNetwork()`（npm `microsandbox@0.5.4` では `network()` は callback 形式 `network((b)=>...)` で、旧設計の `.network({ enabled })` オブジェクト渡しは存在しない） | 最小権限。pypi 等が必要な場合は `execute_code_with_network` |
| `execute_code_with_network` の挙動 | default-deny + allow-list (`pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`, `objects.githubusercontent.com`)。RFC1918/loopback/cloud metadata は常時ブロック | TS SDK（npm `microsandbox@0.5.4`）の `.network((b) => ...)` callback で設定。**default-deny を基礎**にし、DNS と allow-list ドメインのみ許可する `{ rules: [Rule.allowDns(), Rule.allowEgress(Destination.domain("pypi.org")), Rule.allowEgress(Destination.domain("files.pythonhosted.org")), ...] }` を渡す（`NetworkPolicy.publicOnly()` は public 宛先**全般**を許可してしまい allow-list 用途には不適なので使わない）。`NetworkPolicy`（`none/allowAll/publicOnly/nonLocal` factory）/ `Destination` / `Rule` / `NetworkPolicyBuilder` / `RuleBuilder` は package から export 済み。allow-list は環境変数で拡張可。**network callback 内で policy を適用する正確な形のみ Phase A で実コード最終確認** |
| Network tool 有効化ゲート (二段階) | **`code_execution_network_enabled = false` がデフォルト**。`code_execution_enabled = true` でも `_with_network` tool は LLM に expose されない。両 toggle が true で初めて両 tool が tools 配列に入る | 「コード実行 OK」と「コード実行 + 外部ネット OK」を分離。npm/pip install は postinstall で任意コード実行できるため、サーバ管理者が **追加で意識的に許可**する必要 |
| Tool call の承認モデル | 両 tool とも自動実行 (per-execution の UI 承認ボタンなし) | **封じ込めは microVM sandbox が担う**。hermes-agent のセキュリティモデルに従えば、人手承認ゲートは**ヒューリスティック（事故防止）であって封じ込め (containment) ではない**: 承認者は実行前にコードが安全か確実に判定できず、攻撃者が承認を素通りさせる手段もある。真の境界は microVM 隔離 + default-deny egress で、**承認の代替**として二段階 guild toggle（`code_execution_enabled` + `code_execution_network_enabled`）が「コード実行を許す/外部ネットまで許す」の意思決定ゲートを担う。sandbox がある以上、per-execution 承認は事故防止以上の価値を持たず、毎回の UI 確認は UX を著しく悪化させるだけなので採らない。**ただし `_with_network` は封じ込め議論とは別の "data-loss 境界" を開く**点を明示する: microVM は **host 副作用**を封じ込めるが、egress を許した時点で allow-list ホスト（および DNS）が prompt/コード由来データの**持ち出しチャネル**になりうる（egress 内容まで sandbox は防げない）。したがって `_with_network` の guild toggle は「allow-list 宛 egress があり得ることへの**粗粒度の同意**」と位置づけ、(1) DNS は任意ドメイン解決（DNS tunneling による exfil）を許さない方針を Phase A で確認（理想は allow-list ドメインの解決のみ／少なくとも resolver を絞る）、(2) network 実行は admin 向けログ（下記「セキュリティ・観測」の `network` フィールド）に必ず記録、で残余リスクを surface する |
| Tool 結果の LLM 渡し形式 | JSON 文字列で **stdout/stderr は各々 head+tail 合計 ≤ 8 KB（marker 込み）** (`SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES = 8192`, `SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES = 8192`)、超過時は `"\n...[truncated N bytes]...\n"` で head/tail をおおよそ半々に繋ぐ（marker の byte 数を cap 内で予約するため実 head/tail は各 4 KB 弱。下記 `clipHeadTailBytes`）。`exitCode` / `durationMs` / `truncated` / `files: [{name, size, mime}]` (file bytes は含めない) を付ける | host 側で受け取った 256 KB stdout をそのまま LLM context に流すと token 消費が暴騰 (例: 64K tokens = $0.06+)。Discord にはフル出力を attachment で渡しつつ、LLM には head+tail プレビューだけ渡す。`JSON.stringify` で `Uint8Array` が壊れる + バイナリを LLM context に流すのは無駄 |
| 出力 UI フレームワーク | Components V2 (`Container` + `TextDisplay` + `MediaGallery` + `File` + `Section`/`Button`) | embed の 4096 字制限を解消、画像 + 長文ファイルを統一表示。V2 では `files: [...]` payload upload + `attachment://<filename>` 参照の経路は維持される ([Discord File component spec](https://docs.discord.com/developers/components/reference)) |
| Discord mention safety | 全 V2 メッセージ送信で `allowedMentions: { parse: [] }` を強制 | sandbox stdout に `@everyone` / `<@&roleId>` を書く攻撃ベクトルを遮断。TextDisplay は legacy embed.description と違い ping を発火する |
| 画像出力ピックアップ | sandbox 終了後 `/tmp/out/*.{png,jpg,jpeg}` を `MediaGallery`、`/tmp/out/*.svg` 及び `/tmp/out/*` (他形式) を `File` | matplotlib / Pillow の慣習的な出力場所。SVG は Discord client の inline 描画挙動が安定しないため `File` で配布、ユーザがダウンロード閲覧 |
| 画像枚数上限 | MediaGallery は 1-10 枚 (Discord 公式)、超過分は `File` に振り分け | Discord API 仕様 |
| ユーザ UI v1 (リリース時) | LLM tool call のみ。`/run` は **dev only**、`NODE_ENV !== "production"` で条件付き登録 | LLM チャット経由が主目的。`/run` は実装/手動テスト用 |
| `/run` UI (dev only) | `/run` (option なし) → Modal 1 枚に `Label`-wrap した `StringSelect(language)` + `TextInput(code, paragraph, max=4000)` + `TextInput(timeout, short, optional)` | 2025-09 から modal 内 select 可。slash option を削減 |
| `/run` の defer 戦略 | `deferReply()` (**非 ephemeral**) で 15 分窓を確保 → `editReply()` で最終結果。ephemeral にすると editReply も ephemeral 固定で出力が消えるため | dev only でも結果を残したい |
| 言語選択 | modal 内 `StringSelect` の choices で `python` / `node` / `bash` 固定 | v1 は限定。tool 側 `language` enum と同一定義を import |
| Re-run ボタン | **v1 では不採用**。再実行したい場合は LLM に再依頼または `/run` を再度叩く | Re-run には `last_code` を保存する仕組みが必要だが、コード本体はログしない方針 (プライバシー + token 削減) と矛盾。「コードを ephemeral DB / in-memory map に保存」は追加実装でリスクも増えるため v1 では諦める |
| DB スキーマ | `guild_settings.code_execution_enabled INTEGER DEFAULT 0` + `code_execution_network_enabled INTEGER DEFAULT 0` のみ | per-call sandbox により `sandbox_sessions` 不要 |
| Streaming と tool calling の連携 | **foundation の `runToolLoop()` が担う**（delta 蓄積・tool_call 完成判定・マルチターン）。本 change は **完了時の `render`（最終 `ExecResult` を整形した V2 Container）を `handler` の戻りで返すだけ** | `runToolLoop()` の updater が begin（「コード実行中...」の汎用 progress、実行前なので `ExecResult` なし）/ end フックを呼ぶ。begin の汎用 progress 描画は **foundation/updater 側**が担い、本 change はせいぜい tool 表示名などの静的メタを渡す。`codeExecutionService.formatToolBlock(result)` は `ExecResult` を要するので **完了後の `render` 生成にのみ**使う（begin には使えない）。streaming protocol そのものは foundation の責務 |
| Reasoning モデルでの tool calling | サポート対象として明示しない（warning なし。protocol 整合は foundation 任せ） | DeepSeek V4 / GPT-5 / Claude Haiku 4.5 等は問題ないと判断。問題が出たらモデル選定 UI 側で対処 |
| PATCH rate limit (output メッセージ更新) | **foundation + chat-response-v2 側で対応**（2 秒 debounce + 429 スキップ）。本 change では別途実装しない | tool 実行中の進捗 edit は updater 経由で発生し、Discord channel-level PATCH rate limit (5/5s) との衝突回避は updater 側の責務 |

## Design

### アーキテクチャ

```text
┌─────────────────────────────────────────────────┐
│ Proxmox LXC (unprivileged, nesting=1)           │
│  /dev/kvm → bind                                │
│  ┌──────────────────────────────────────────┐   │
│  │ Docker (Coolify)                         │   │
│  │  ┌────────────────────────────────────┐  │   │
│  │  │ Bot Container (oven/bun:1-debian)  │  │   │
│  │  │  --device /dev/kvm                 │  │   │
│  │  │  group_add: kvm                    │  │   │
│  │  │  vol: /data/microsandbox            │  │   │
│  │  │                                    │  │   │
│  │  │  chatService ─► runToolLoop ─┐     │  │   │  ← foundation
│  │  │   (LLM)        (foundation)   │     │  │   │
│  │  │                 dispatch      │     │  │   │
│  │  │                 IClientTool   ▼     │  │   │
│  │  │                 handler ─► runCodeExecution  │  ← 共有ヘルパ
│  │  │  /run cmd ──────────────────►  │    │  │   │  ← /run は loop/handler を介さず直接呼ぶ
│  │  │                                ▼    │  │   │
│  │  │            sandboxService           │  │   │
│  │  │              │ napi (microsandbox)  │  │   │
│  │  │              ▼                     │  │   │
│  │  │           libkrun → /dev/kvm       │  │   │
│  │  │              │                     │  │   │
│  │  │              ▼                     │  │   │
│  │  │      ┌────────────────────┐        │  │   │
│  │  │      │ microVM            │        │  │   │
│  │  │      │ name=exec-<uuid>   │        │  │   │
│  │  │      │ per tool call,     │        │  │   │
│  │  │      │ destroyed after    │        │  │   │
│  │  │      │ agentd inside      │        │  │   │
│  │  │      └────────────────────┘        │  │   │
│  │  └────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 変更対象ファイル

**新規:**

- `src/services/sandboxService.ts` — per-call sandbox lifecycle (`execute()` のみ)、グローバル同時実行キュー、起動時 image pre-pull、**`/tmp/out/*` のファイル収集（sandbox 破棄前に実施し `ExecResult.files` に載せる）**、timeout/cancel 時の `ExecHandle.kill()` → `sandbox.kill()` 経路
- `src/services/codeExecutionService.ts` — Discord 整形ロジック (V2 Container 構築 = `formatToolBlock()` / `/run` 出力、**`ExecResult.files` を `File`/`MediaGallery` に振り分け**、`allowedMentions: { parse: [] }` 強制、SVG/その他は `File`、bitmap 画像は `MediaGallery`)。**fs 収集は行わない**（sandbox は sandboxService が既に破棄済みのため、整形時点で sandbox FS にはアクセスしない）
- `src/llm/tools/codeExecution.ts` — foundation の `IClientTool` 実装（`execute_code` / `execute_code_with_network`）。`isEnabled`（guild 2 toggle + `SANDBOX_ENABLED`）・`validate`・`timeoutMs`・`handler`（`sandboxService.execute()` 呼出 + `toolResultForLlm` / `formatToolBlock` で `{ llmResult, render }` を組む）。**この 2 tool 値を export するだけ**で、`ToolRegistry.register()` の呼出は合成ルート（`src/index.ts`、下記「修正」）が行う（foundation 所有の registry は本ファイルから触らない。二重登録を避ける）。tool 配列組立・`tool_choice`・空 omit は foundation 側
- `src/bot/commands/run.ts` — `/run` スラッシュコマンド + Modal handler (`NODE_ENV !== "production"` のみ登録)
- `tests/unit/services/sandboxService.test.ts`
- `tests/unit/services/codeExecutionService.test.ts`
- `tests/unit/llm/codeExecutionTool.test.ts` — `IClientTool` の `isEnabled`（2 toggle 分岐）・`validate`・`handler` が `{ llmResult, render }` を正しく返すか（foundation の `runToolLoop` 自体は foundation 側テストで担保）
- `tests/integration/codeExecution.test.ts` — 実 sandbox を 1 回起動する smoke test (CI では skip、ローカル `KVM_AVAILABLE=1` で実行)

**修正:**

- `src/index.ts`（DI / composition root） — 本 change が **export** した `executeCodeTool` / `executeCodeWithNetworkTool` を、起動時に foundation の `ToolRegistry.register()` で登録する（**foundation 所有の `registry.ts` 等は本 change で編集しない**。tool 値は本 change が export し、登録呼出は合成ルートが行う）。streaming ループ（`chatService` の `runToolLoop()` 経由化）・`openrouter.ts` の `tools` / `tool_choice` 送出と tool_call delta パースは **すべて foundation 側で実装済み**（本 change では触らない）
- `src/db/schema.ts` — `guild_settings` に `code_execution_enabled INTEGER DEFAULT 0` + `code_execution_network_enabled INTEGER DEFAULT 0` 2 カラム追加。**`sandbox_sessions` テーブルは作らない**
- `src/db/repositories/guildSettingsRepository.ts` — 2 フラグの getter/setter
- `src/config/envVars.ts` — `SANDBOX_ENABLED` / `SANDBOX_MAX_CONCURRENT` / `SANDBOX_DEFAULT_CPUS` / `SANDBOX_DEFAULT_MEMORY_MIB` / `SANDBOX_NETWORK_ALLOWLIST` / `SANDBOX_OUTPUT_MAX_BYTES_HOST` / `SANDBOX_OUT_FILES_MAX_BYTES` / `SANDBOX_OUT_FILES_MAX_COUNT` / `SANDBOX_FILE_MAX_BYTES` / `SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES` / `SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES` / `SANDBOX_CODE_MAX_CHARS` / `SANDBOX_BOOT_DEADLINE_MS` / `SANDBOX_COLLECT_DEADLINE_MS` / `SANDBOX_TEARDOWN_DEADLINE_MS` / `MSB_HOME`（`SANDBOX_TOOL_RESULT_*` は marker 長以上であることを起動時 validate。budget 不変条件も起動時に validate するが、**`SAFETY_MARGIN_MS` を含み `actualToolTimeoutMs` 基準で**正確に書く: 一般形は `QUEUE_WAIT_MS + SANDBOX_BOOT_DEADLINE_MS + effectiveTimeoutSecMax*1000 + SANDBOX_COLLECT_DEADLINE_MS + SANDBOX_TEARDOWN_DEADLINE_MS + SAFETY_MARGIN_MS ≤ actualToolTimeoutMs`〔`actualToolTimeoutMs = min(180_000, C)`〕。これは effectiveTimeoutSecMax の導出式（`floor((actualToolTimeoutMs − OVERHEAD_MS − SAFETY_MARGIN_MS)/1000)`）から構成上つねに成立するので、Phase C で C 確定後に assert する。env ロード時点（C 未知）の guard は弱い形 `OVERHEAD_MS + SAFETY_MARGIN_MS + 1000 ≤ 180_000`〔= 要求 timeoutMs〕で、デッドライン env を盛りすぎて exec 予算が正にならない（effectiveTimeoutSecMax < 1 で fail-closed になる）設定を早期に検出する。TTL / idle 系は不要）
- `src/bot/commands/config.ts` — `/config code-execution <on|off>` + `/config code-execution-network <on|off>` 2 サブコマンド
- `src/bot/commands/index.ts` — `/run` を dev only 条件付き登録 (`if (process.env.NODE_ENV !== "production") commandDefinitions.push(runCommand)`)
- `src/bot/events/interactionCreate.ts`(or 該当 handler) — Modal submit ハンドラ。Re-run button は v1 では実装しない
- `package.json` — `microsandbox` 依存追加（最新 v0.5.4、Apache-2.0、活発にメンテ中）。`discord.js` は **`LabelBuilder`（modal 内 select / RadioGroup / Checkbox）対応済みのため bump 不要**（インストール済み `^14.26.4`、`LabelBuilder` は v14.25.1+）
- Dockerfile (image build 部分) — ベースは glibc ≥ 2.39 を満たすもの（`oven/bun:1-debian` が満たさなければ `ubuntu:24.04` + Bun 等）、`apt-get install -y --no-install-recommends ca-certificates` 程度
- docker-compose.yml / Coolify 設定 (runtime / orchestration 部分) — `devices: [/dev/kvm:/dev/kvm]` + `group_add: [kvm]` + volume `microsandbox_cache:/data/microsandbox`、entry script で `/dev/kvm` の存在を確認しない場合 fail-fast (`SANDBOX_ENABLED=true` のときのみ)

### DB スキーマ

```sql
ALTER TABLE guild_settings ADD COLUMN code_execution_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN code_execution_network_enabled INTEGER NOT NULL DEFAULT 0;
```

per-call lifecycle により sandbox 一覧テーブル（DB 駆動の孤児追跡）は持たない (sandbox は exec 終了時に後始末する: 正常完了は `stopAndWait()`〔失敗時は `sandbox.kill()` にエスカレーション〕、timeout は `ExecHandle.kill()`→収集→teardown、cancel/wall-timeout は `ExecHandle.kill()` → `sandbox.kill()` の後に `removePersisted()` まで実行。最終 `removePersisted()` まで失敗した稀ケースの孤児 persisted エントリ（MSB_HOME 内の microsandbox メタデータ/disk。app 側 DB ではない）は best-effort で log のみで、startup でその存在を前提にしない)。**ただしプロセス/コンテナのクラッシュが create 後 removePersisted 前に起きると、in-process finally では掃除しきれず MSB_HOME に persisted エントリ（と場合により稼働中 microVM）が残りうる**。これは「次回起動が依存しない」では storage/リソース leak を bound できないため、**DB を使わない stateless な起動時 name-prefix sweep**（所有プレフィクス `exec-`/`prewarm-` の persisted sandbox を列挙し best-effort で kill/removePersisted）を起動時に 1 回行う（下記 Tasks）。sandbox_sessions テーブルは依然不要。

### LLM tool 定義（foundation への `IClientTool` 登録）

2 tool は [tool-calling-foundation](../tool-calling-foundation/design.md) の `IClientTool` として実装し、`ToolRegistry.register()` する。`name` / `description` / `parameters`（JSON Schema）に加え、`isEnabled(ctx)`（guild の 2 toggle と `SANDBOX_ENABLED` で評価）・`validate(args)`（runtime 検証）・`timeoutMs`・`handler(args, ctx, signal, meta)`（sandbox 実行）を提供する。

`tools` 配列の組み立て・`tool_choice`・空配列 omit（一部上流が `tools:[]` + `tool_choice` を 400 にする件）は **foundation 側で一元処理**される。本 change は `isEnabled` を正しく返すことで、無効 guild の tool が `buildTools()` の結果から外れる（= request から消える）ことを保証するだけでよい。

```ts
// src/llm/tools/codeExecution.ts
import type { IClientTool, IToolContext } from "../tools/registry";

// config から組み立てる（frozen const ではない）: timeout_sec の maximum は実 clamp 由来の
// effectiveTimeoutSecMax（標準 clamp C≥180s なら 120）、default は min(30, effectiveTimeoutSecMax)、
// code の maxLength は SANDBOX_CODE_MAX_CHARS。
// これにより「schema の maximum/default」「validate の上限」「/run modal の上限/初期値」が単一の config を共有する。
function buildCodeExecParameters(cfg: { timeoutSecMax: number; defaultTimeoutSec: number; codeMaxChars: number }) {
  return {
    type: "object",
    properties: {
      language: { type: "string", enum: ["python", "node", "bash"] },
      code: { type: "string", description: "Source code to execute", maxLength: cfg.codeMaxChars },
      // default は固定 30 ではなく min(30, timeoutSecMax)。clamp 値が小さく effectiveTimeoutSecMax < 30 でも
      // default が maximum を超えない（schema 不正・budget 不変条件違反を防ぐ）
      timeout_sec: { type: "integer", minimum: 1, maximum: cfg.timeoutSecMax, default: cfg.defaultTimeoutSec },
    },
    required: ["language", "code"],
  } as const;
}
// cfg.timeoutSecMax = effectiveTimeoutSecMax（Decisions「wall timeout budget 不変条件」）、
// cfg.defaultTimeoutSec = min(30, effectiveTimeoutSecMax)、cfg.codeMaxChars = SANDBOX_CODE_MAX_CHARS。
// validate() / runtime default / /run modal も同じ cfg.defaultTimeoutSec・cfg.timeoutSecMax を参照する。
const codeExecParameters = buildCodeExecParameters(sandboxToolConfig);

export const executeCodeTool: IClientTool<CodeExecArgs> = {
  name: "execute_code",
  description:
    "Execute code in an isolated microVM sandbox. Each call runs in a fresh sandbox; variables, imports, and generated files do NOT persist across calls. Network is disabled. Save generated images to /tmp/out/*.{png,jpg,jpeg,svg} to display them.",
  parameters: codeExecParameters,
  timeoutMs: 180_000, // foundation の wall timeout。budget: queue待ち(≤5s)+boot+args.timeout_sec(≤120s)+/tmp/out収集+teardown を収める（下記 Decisions「実行タイムアウト」の budget 不変条件）。実行内タイムアウトは args.timeout_sec
  // SANDBOX_ENABLED かつ guild の code_execution_enabled。buildTools と dispatch の両方で評価される
  isEnabled: (ctx: IToolContext): boolean =>
    sandboxFeatureEnabled() && isCodeExecEnabled(ctx.guildId),
  validate: (args: unknown) => validateCodeExecArgs(args), // enum / 文字数 / timeout 範囲を runtime 検証
  handler: async (args, ctx, signal, meta) =>
    runCodeExecTool({ ...args, networkAllowed: false }, ctx, signal, meta),
};

export const executeCodeWithNetworkTool: IClientTool<CodeExecArgs> = {
  name: "execute_code_with_network",
  description:
    "Same as execute_code but allows outbound network to a curated allow-list (PyPI, npm registry, GitHub object storage). Use only when package installation or external API is required. Each call is still in a fresh sandbox.",
  parameters: codeExecParameters,
  timeoutMs: 180_000,
  // 二段階ゲート: network toggle も true のときだけ expose
  isEnabled: (ctx: IToolContext): boolean =>
    sandboxFeatureEnabled() &&
    isCodeExecEnabled(ctx.guildId) &&
    isCodeExecNetworkEnabled(ctx.guildId),
  validate: (args: unknown) => validateCodeExecArgs(args),
  handler: async (args, ctx, signal, meta) =>
    runCodeExecTool({ ...args, networkAllowed: true }, ctx, signal, meta),
};

// 共通ハンドラ: sandbox 実行 → LLM 結果整形 + Discord 描画断片
async function runCodeExecTool(
  args: CodeExecArgs & { networkAllowed: boolean },
  ctx: IToolContext,
  signal: AbortSignal,           // foundation の cancel / wall timeout signal
  meta: { requestId: string; toolCallId: string; invocationId: string },
): Promise<{ llmResult: string; render: ToolRenderPayload }> {
  // sandboxService.execute は（kill 順序は Decisions「実行タイムアウト（sandbox 内）」参照）:
  //  - foundation の signal が abort したら（request cancel / per-tool wall timeout の双方）
  //    ExecHandle.kill() → 即 sandbox.kill()（収集スキップ）で cleanup してから generic な abort を throw する
  //    （正常結果を返さない。cancel/timeout の分類は foundation が signal 状態で行うので error 型は問わない）
  //  - args の timeout_sec（sandbox 内タイムアウト）に達したら ExecHandle.kill()（ユーザプロセスのみ）→
  //    VM を壊す前に /tmp/out + bounded stdout/stderr を収集 → teardown し、
  //    systemError.kind:"timeout" を載せた *正常な*（部分出力を含む）ExecResult を返す（reject しない）
  const result = await runCodeExecution(args, signal);  // 下記の共有ヘルパ。/run も同じものを使う
  return {
    llmResult: JSON.stringify(toolResultForLlm(result)),  // 文字列。head+tail clip、file bytes 除外
    render: codeExecutionService.formatToolBlock(result), // attachment-capable payload: V2 components + files + flags
  };
}

// /run コマンドと IClientTool.handler の両方が使う低レベルヘルパ。
// foundation の IToolContext / meta / updater には依存しない（純粋に sandbox を回すだけ）。
function runCodeExecution(
  args: CodeExecArgs & { networkAllowed: boolean },
  signal?: AbortSignal,
): Promise<ExecResult> {
  return sandboxService.execute({
    language: args.language,
    code: args.code,
    timeoutSec: args.timeout_sec ?? sandboxToolConfig.defaultTimeoutSec, // 固定 30 ではなく config 共有値（min(30, effectiveTimeoutSecMax)）
    networkAllowed: args.networkAllowed,
    signal,                       // foundation 経路では渡る。/run 経路では interaction 連動の signal か未指定
  });
}
```

`isEnabled` が `false` を返す tool は foundation の `buildTools(ctx)` から除外され、dispatch 時にも再評価されるため、無効 guild ではモデルが既知 tool 名を捏造しても実行されない。二段階ゲート（`code_execution_enabled` だけ true なら `execute_code` のみ expose、両 toggle true で `_with_network` も expose）は **2 つの `isEnabled` 実装で表現する**。

`handler` の戻りは foundation 契約の `{ llmResult: string; render?: ToolRenderPayload }`:

- `llmResult` — `toolResultForLlm(execResult)` を JSON 文字列化したもの（stdout/stderr は head+tail clip、file bytes は含めない。foundation がさらに UTF-8 安全な最大 byte clip をかける）。
- `render` — Discord 描画断片。foundation 契約上は `ToolRenderPayload`（updater が解釈する不透明 payload）だが、**本 change は render が attachment-capable（V2 components + 添付ファイル payload + flags + `allowedMentions`）であることを upstream 契約への要件として surface する**（下記「Discord 出力整形ルール」の `ToolRenderPayloadShape`・Risk 参照）。`codeExecutionService.formatToolBlock(execResult)` が生成し、foundation の updater がチャットに反映する。バイナリ file bytes はここで Discord upload に渡す（LLM context には流さない）。

### sandboxService の主要 API

```ts
interface ISandboxService {
  // 起動時に 3 言語 image を事前 prewarm (create → stopAndWait → removePersisted で layer cache を満たし、prewarm sandbox は残さない)
  // per-call と同様 finally で removePersisted() まで実行し、prewarm 由来の persisted エントリ/name 衝突を残さない。
  // **readiness gate**: 完了したら readiness フラグを立て、sandboxFeatureEnabled() がそれを参照する。
  // 合成ルートは SANDBOX_ENABLED=true のとき本メソッドを await してから tool を register/expose・/run を受け付ける
  // （cold な image pull を実 tool call の 180s wall budget に持ち込まない）。失敗時は v1 では feature 全体を fail-closed
  // （per-language 部分無効化は固定 enum + tool-level isEnabled では表現できないため v1 では行わない）。
  prewarmImages(): Promise<void>;

  // per-call lifecycle:
  //   各 phase は **個別の有界サブデッドライン**下で動かし、foundation の 180s wall timeout に到達する前に自力 settle する
  //   （wall budget 不変条件: queue ≤5s + boot ≤SANDBOX_BOOT_DEADLINE_MS + timeout_sec ≤120s + 収集 ≤SANDBOX_COLLECT_DEADLINE_MS + teardown ≤SANDBOX_TEARDOWN_DEADLINE_MS = 170s ≤ 180s。Decisions 参照）:
  //   1. let b = Sandbox.builder(`exec-${crypto.randomUUID()}`).image(img).cpus(1).memory(MiB(512));
  //      b = networkAllowed ? b.network((n) => n.policy(allowListPolicy)) : b.disableNetwork();
  //      const sandbox = await b.create();   // pull 完了を確実に待つなら createWithPullProgress() も可
  //      ★ boot は SANDBOX_BOOT_DEADLINE_MS で race。超過したら kill → systemError.kind:"boot_failed" の正常 ExecResult（prewarm 済み warm boot 前提なので通常即時）
  //   2. sandbox.exec("python", ["-c", code]) など (複数行 code は exec の args か shell(script)。Phase A で確定) を args.timeout_sec / signal で race
  //   3. /tmp/out から fs() 経由で生成ファイルを **sandbox 破棄前に** 読み取り (詳細下記、list()/read())。
  //      ファイル収集は sandboxService の責務（codeExecutionService は ExecResult.files を整形するだけ）。
  //      ★ 収集全体を SANDBOX_COLLECT_DEADLINE_MS で打ち切り（超過分は filesOmittedAtLeast=true）。bounded enumeration（cap+1, wc -l しない）+ per-file bounded read で host メモリも bound
  //   4. **終了経路で kill 順序が分岐する**（Decisions「実行タイムアウト（sandbox 内）」参照）:
  //      - 正常終了: stopAndWait()（失敗時 sandbox.kill()）。手前で step 3 の収集済み。
  //      - (A) args.timeout_sec 到達（正常 timeout 結果）: ExecHandle.kill()（ユーザプロセスのみ）→ **VM を壊す前に** step 3 の収集を実施 → stopAndWait()（失敗時 kill()）。systemError.kind:"timeout" + 部分出力の正常 ExecResult を返す。
  //      - (B) signal.aborted（foundation の cancel / wall timeout、結果不明）: ExecHandle.kill() → **即 sandbox.kill()（収集スキップ）** → throw。結果を返さない経路なので /tmp/out を読まない。
  //      ★ teardown は SANDBOX_TEARDOWN_DEADLINE_MS で bound。**超過時の挙動は下記「teardown 超過の単一ステートマシン」に従い `sandbox.kill()`（安全境界）と `removePersisted()`（後始末）を区別する**:
  //      `sandbox.kill()` 確定後に `removePersisted()` だけが超過したケースは handler を即 settle して **permit を解放**し、残り `removePersisted()` は permit 非保持の detached 有界リトライへ（失敗時 leak warn → 起動時 sweep）。
  //      `sandbox.kill()` 自体を有界予算内に確定できないケースは **permit を強制解放せず** feature を fail-closed にする（生きた VM/egress を残したまま契約成立を偽称しない）。これが foundation の killable isolation 契約を満たす
  //   5. (再利用しないので必ず sandbox.removePersisted() で DB エントリも掃除)
  // クリーンアップ不変条件: sandbox を create() できたら、以降は必ず後始末する。
  //   - **create() への abort race（detached cleanup が必須）**: foundation は handler 完了と cancel/timeout を race し、
  //     abort 勝利時は handler の完了を待たない。`create()` が **非中断**だと、handler が先に throw/return した後に
  //     create が resolve しうる。このとき **通常の `finally` では掃除できない**（finally は関数 exit 時に走り、関数 exit 後に
  //     resolve した promise には届かない）。そこで boot deadline / abort で create 未 resolve のまま脱出する前に、
  //     **detached なクリーンアップ継続を明示登録してから** throw/return する:
  //       `void createPromise.then((s) => cleanupCreatedSandbox(s, "abort-or-boot-timeout")).catch(logCleanupError);`
  //     （`cleanupCreatedSandbox` は sandbox.kill() → removePersisted() の二段エスカレーション）。これにより
  //     「handler settle 後に遅れて生まれた sandbox」も確実に kill/removePersisted され、leak しない。
  //   - **create() 自体がハングするケース（permit を永久に握らないための create-abandon 状態）**: 上の detached cleanup は
  //     `createPromise` が *resolve/reject する* 前提で permit を保持・解放する。`create()` が**いつまでも settle しない**と、
  //     handler は boot deadline で settle するのに `createPromise.then(...)` が発火せず **permit が永久に解放されない**（N 枯渇）。
  //     対策は **生成中の sandbox を *name 指定* で abandon できること**に依る（本 change は `exec-${uuid}` の name を create 前に
  //     決めている）: boot deadline で createPromise を待たずに **name 指定の `Sandbox.kill(name)`（+ `removePersisted(name)`）を
  //     有界に発行**して、まだ生まれていない/生まれかけの VM を name で破壊し、その確定をもって permit を解放する（起動時
  //     name-prefix sweep と同じ name ベース回収を *その場で* 使う）。permit 解放は **createPromise の resolve か name 指定 kill の
  //     確定のいずれか早い方**で行う。**`create()` が外部からキャンセル/ name 指定 kill 可能であることは Phase A で検証**し、
  //     不可能（create が無制限にハングしうるうえ name でも殺せない）なら、その経路は **degraded/fail-closed**（feature を
  //     unhealthy にして新規受付を止める）に倒す — 「boot は wall でも permit でも有界」と主張できるのはこの create-abandon が
  //     成立する場合に限る（成立しないなら boundedness を偽称しない）。
  //   - **同時数 permit は VM 停止（`sandbox.kill()`/`stopAndWait()`）の確定まで保持する**: concurrency permit（Bottleneck slot 相当）を
  //     handler の return に紐づけて解放すると、handler が abort で先に throw した直後に slot が空き、まだ resolve して
  //     いない createPromise（+ そこから生まれる orphan VM）が同時数 N にカウントされなくなる。abort を連打されると
  //     orphan create が積み上がり実 VM 数が N を超えうる。よって permit の解放は **(success) teardown の sandbox 停止確定時 /
  //     (abort・boot-timeout) detached cleanup 内の `sandbox.kill()`（または name 指定 kill / 停止確定）時**に行い、handler の早期 throw とは切り離す。
  //     **permit が bound するのは「生きている VM 数」なので解放の基準は VM 停止の確定**であり、停止後に残る `removePersisted()`（メタデータ削除）は
  //     **permit 非保持の detached**で回す（残骸であって稼働 VM ではない）。VM 停止を有界に確定**できない**ケースだけは permit を解放せず fail-closed
  //     にする（下記「teardown 超過の単一ステートマシン」(3)）。これにより active + 生成中 + teardown(VM 停止待ち) 中の合計が常に N 以下に bound され、
  //     かつ「`removePersisted()` の遅延/hang で permit が永久に握られ N 枯渇」も避けられる。
  //   - **teardown 超過の単一ステートマシン**（wall budget・permit 不変条件・killable isolation の両立）。**teardown を 2 段に分け、
  //     安全クリティカルな VM 破棄（`sandbox.kill()`）と単なるメタデータ削除（`removePersisted()`）を区別する**:
  //     ・**`sandbox.kill()`（= ユーザコード + ネットワークを物理的に停止する安全境界）は必ず（有界に）完了させ、その確定まで permit を保持する**。
  //       これが foundation の killable isolation 契約の本体（best-effort で済ませない）。**foundation は handler の settle を待たず race で分類するので、kill は
  //       handler の throw を待たせる必要はなく permit-held なクリーンアップ継続で完了させてよい**（throw 自体は即時でも、kill 確定まで permit が slot を占有するので
  //       live VM は N に bound、副作用も断たれる）。`sandbox.kill()` 自身を有界リトライ（短い deadline × 数回）で叩き、ハングに備える。
  //     ・`removePersisted()`（VM 停止後に残る persisted メタデータ/disk エントリの削除）**のみ** best-effort/detached でよい。
  //       これは「実行中の VM/egress」ではなく後始末の残骸なので、失敗しても起動時 name-prefix sweep が回収する。
  //     状態遷移: (1) `sandbox.kill()` 確定 + `removePersisted()` 期限内完了 → permit 解放 + handler settle。
  //     (2) `sandbox.kill()` は確定したが `removePersisted()` が SANDBOX_TEARDOWN_DEADLINE_MS を超過 → **VM はもう無い**ので
  //        permit を解放し handler を即 settle、`removePersisted()` だけ detached の有界リトライへ（失敗時は leak warn ログ → 起動時 sweep）。
  //     (3) **`sandbox.kill()` が有界リトライ予算内に確定できない（VM を殺せたと証明できない）→ killable isolation 不成立**。
  //        この場合 **permit を解放して契約成立を主張しない**: 機能を degraded/unhealthy にマークして新規 exec 受付を止め（fail-closed）、
  //        admin に alert する（実行中の VM・`_with_network` なら生きた egress が封じ込めから漏れている可能性があるため、
  //        「permit 強制解放 + 起動時 sweep 任せ」では安全契約に反する）。Phase A で **`sandbox.kill()`（名前指定含む）が有界かつ
  //        確実に VM を破棄する**ことを検証し、保証できないなら feature を enable しない。
  //     これにより「`removePersisted()` hang で permit が永久に握られ N 枯渇」も「handler が 180s wall 超過」も回避しつつ、
  //     **生きた VM/egress を残したまま killable isolation 成立を偽称することがない**（(3) は permit 解放ではなく feature 停止に倒す）。
  //     create が handler 内で resolve した場合は直後に `signal.aborted` を再確認し、true なら exec せず sandbox.kill() → removePersisted() → throw。
  //     ExecHandle 取得中の abort では handle が無くても sandbox 全体を kill する（handle 無し=in-VM プロセス未起動なので sandbox.kill() で十分）。
  //     ※ unit test 要件: **create() が handler settle 後に resolve するケース**で sandbox が exec されず必ず kill/removePersisted されることを検証。
  //   - どの脱出経路（create 部分成功 / create 後 abort / exec throw / fs.read 失敗 / stopAndWait 失敗 / file 収集中の abort）でも
  //     ExecHandle があれば ExecHandle.kill() → sandbox.kill()（abort/error 時）または stopAndWait()（success 時）→
  //     sandbox.removePersisted() を実行する。
  //   - **stopAndWait() 失敗時はエスカレーション**: success 経路でも stopAndWait() が throw したら sandbox.kill() に
  //     フォールバックしてから removePersisted() を試す。removePersisted() まで失敗した場合は best-effort（log のみ・投げ直さない）。
  //     つまり「孤児を残さない」は **kill→removePersisted の二段エスカレーションでの best-effort 保証**であり、
  //     最終 removePersisted まで失敗した稀ケースの孤児 persisted エントリ（MSB_HOME 内のメタデータ/disk、app 側 DB ではない）は startup の存在前提に依らない（per-call なので次回起動で参照しない。起動時 name-prefix sweep が best-effort で回収）。
  // 同時実行数が SANDBOX_MAX_CONCURRENT を超えると **明示的な abort-aware カウンティング semaphore** のキューで待機。
  //   （auto-release-on-settle の limiter〔Bottleneck/p-limit の標準 schedule 用法〕は使わない: permit を物理クリーンアップ
  //    完了まで保持する必要があり、ジョブ promise settle での自動解放だと orphan create を取りこぼす。下記★参照）
  //   待機が 5 秒を超えたら sandbox を作らず、systemError.kind:"queue_timeout" を載せた **正常な ExecResult を返す**（throw しない）。
  //   これにより /run と LLM tool 経路の描画が timeout 系（args.timeout_sec）と同一経路に揃う（下記「queue timeout の結果形」参照）。
  // キューの abort-aware 不変条件: signal は **sandbox 作成前**にも効かせ、待機中の abort で handler を **即座に settle** する。
  //   permit 取得を `Promise.race([acquire(), queueTimeout(5s), abortPromise])` で待ち、listener は必ず cleanup する:
  //   (a) ジョブ実行開始時（acquire 直前）と (b) acquire 後 create() 直前に signal.aborted を再確認、
  //       加えて (c) 待機中に signal が abort したら race の abortPromise が勝ち、その場で throw する。
  //   abort 勝利時は **待機中の pending acquire を semaphore の待ちキューから除去**し、acquire が後で解決しても
  //   **skip フラグで no-op 化**して sandbox を作らない（その場合 permit は acquire されないので release も不要）。これにより
  //   「cancel された tool call がキューに居座り、5 秒の queue_timeout やスロット空きまで settle しない」事態を防ぐ。
  //   ※ queue_timeout（5 秒超過）は **正常 ExecResult**、cancel（signal.aborted）は **throw** で扱いが異なる点に注意。
  execute(args: {
    language: "python" | "node" | "bash";
    code: string;
    timeoutSec: number;          // 1..effectiveTimeoutSecMax（標準 clamp 下で 120）。sandbox 内の実行タイムアウト
    networkAllowed: boolean;     // true なら execute_code_with_network 相当
    signal?: AbortSignal;        // foundation の handler から渡る cancel/timeout signal。abort で kill 経路を発火
  }): Promise<ExecResult>;
}

interface ExecResult {
  stdout: string;                // capped capture（256 KB、下記注記の bounded capture 方式で取得）
  stderr: string;                // capped capture（256 KB、同上）
  // プロセスが正常終了した場合の exit code。never-started（queue_timeout / boot_failed）や
  // kill（timeout / cancel / oom）で確定 exit が無い場合は **null**（偽の 0/-1 を載せない）
  exitCode: number | null;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
  // 生成ファイル (画像 + その他)。Discord upload の files: [] payload にそのまま渡す
  files: Array<{ name: string; bytes: Uint8Array; mime: string }>;
  // host 側収集で **列挙済みのうち** 採用しなかった exact 件数（個数 cap / 合計 cap / per-file oversize を計上）。
  // 列挙 cap(COUNT) を超えた未列挙ファイルは exact に数えない（全件 traversal を避けるため。下記収集ロジック参照）。
  // codeExecutionService の warning TextDisplay 表示用（Discord 可視 10 cap での追加省略は formatter 側で別途加算）
  filesOmitted: number;
  // 列挙 cap を超えるファイルが存在した（= まだ未列挙の生成ファイルがある）。true なら warning を「N 件以上」表記にする
  filesOmittedAtLeast: boolean;
  // タイムアウトや OOM 等のシステム例外（queue_timeout もここに載る正常 ExecResult。throw しない）
  systemError?: { kind: "timeout" | "oom" | "boot_failed" | "queue_timeout"; message: string };
}
```

**stdout/stderr の bounded capture（host メモリ保護）**: 256 KB cap は「全部受け取ってから切る」だと microsandbox が exec 完了後に完全な出力を一括返却する実装だった場合 host メモリを bound できない（post-hoc truncate）。そのため capture は **受信時点で 256 KB 上限を効かせる**ことを必須要件とし、次のいずれかで実現する: (a) microsandbox SDK が stdout/stderr の streaming/逐次受信（チャンク callback 等）を提供するなら、それで 256 KB 到達時に以降を捨てて `truncated=true` を立てる。(b) 提供しない場合は**必ず**実行コマンドを wrap して出力を sandbox 内ファイルへリダイレクトし（`exec("bash", ["-lc", script])` の script 側で `user_cmd >/tmp/.cap/stdout 2>/tmp/.cap/stderr; echo $? >/tmp/.cap/exit`）、続く in-sandbox ステップで `head -c 262144` 等により **sandbox 内で** cap してから（`head -c` は**パイプではなくファイル→ファイル**でかけ、SIGPIPE による生成プロセスの早期終了・exit code 汚染を避ける）、host は bounded なファイルだけを `fs().read()` する。exit code は `$?` を別ファイルに退避して透過し、cap で落とした場合は `truncated=true` を立てる。**(b) は exec コマンドを本 change が組み立てる以上つねに実装可能**なので、host が一括 string を抱えたまま後から切る post-hoc truncate には**フォールバックしない**（cap を「LLM/Discord に渡す量の上限」へ緩めて host メモリ保護を VM の memory(512) 隔離に委ねる旧案は、SDK が host 文字列で全量を返す場合に host プロセスのメモリを bound できず不採用）。**(a) と (b) のどちらを採るかだけ Phase A の verify task で SDK の exec 戻り値形（一括 string か stream か）を見て確定する**が、いずれの方式でも host が保持する stdout/stderr は 256 KB に bound される。なお (b) の bash ラッパは **`timeout_sec` の in-VM enforcement とプロセスツリー停止の足場**も兼ねる: ユーザコードを `setsid`（新プロセスグループ）で起動し、ラッパ内の watchdog（`timeout(1)` 相当）が `timeout_sec` 到達でグループごと kill（`kill -TERM -- -<pgid>` → 短い猶予後 SIGKILL）→ reap し、**ラッパ本体は生き残って `$?`／`truncated` メタを capture ファイルへ flush** してから正常終了する。host はラッパの返却（backstop = `timeout_sec` + 猶予 + 小マージン以内）を待って収集する。これにより host は user プロセスを kill する必要がなく（host が wrapper を kill すると exit メタが書けない）、子プロセスが収集ウィンドウ中に `/tmp/out` 書き換えや egress を続けることもない。ラッパが backstop を超過したら host が `sandbox.kill()` + 収集スキップへエスカレーションする（Decisions「実行タイムアウト（sandbox 内）」(A)。in-VM watchdog + メタ flush が Phase A で確立できなければ (A) 全体を VM kill + 収集スキップへフォールバック）。

`/tmp/out/*` の取り出しは microsandbox の `sandbox.fs()` 経由で、**sandbox を破棄する前に sandboxService が行う**（**non-recursive**、サブディレクトリは無視。collection は sandboxService の責務で、codeExecutionService は返ってきた `ExecResult.files` を整形するだけ）。**列挙自体を bound する**のが前提で、`fs.list("/tmp/out")` が全 entry を一括返却する実装だと、sandbox が `/tmp/out` に大量ファイルを作った場合 host が巨大な entry 配列を抱える（listing-time DoS）。そのため列挙は bounded にする:

```ts
const fs = sandbox.fs();
// 1) bounded enumeration: SDK が paginated/ranged list を持てばそれを使う。無ければ sandbox 破棄前に
//    in-sandbox で bounded manifest を作る（host が読むエントリ数を COUNT+1 に bound する）:
//      manifest = `find /tmp/out -maxdepth 1 -type f -printf '%s\t%p\n' | head -n <COUNT+1>`  ← 高々 COUNT+1 行
//    （-maxdepth 1 + -type f で non-recursive・file のみ＝symlink/dir を除外。manifest 自体も head で truncate 済み）。
//    **exact な totalFileCount のための `find ... | wc -l` は行わない**: 全件 traversal は in-sandbox で無制限に
//    伸びうる時間コスト（大量の tiny ファイルで収集 phase が膨張＝SANDBOX_COLLECT_DEADLINE_MS を食う）で、
//    bounded manifest の趣旨を打ち消す。代わりに manifest を **head -n COUNT+1** で読み、cap+1 行目（sentinel）が
//    存在したかで `overflowSeen` を立て、**candidates は先頭 COUNT 件に切る**（sentinel は candidates に含めない）。
const collectDeadlineAt = Date.now() + SANDBOX_COLLECT_DEADLINE_MS;  // 収集 phase 全体のサブデッドライン基準時刻
const { candidates, overflowSeen } = await listBounded(sandbox, "/tmp/out", SANDBOX_OUT_FILES_MAX_COUNT);
let omittedEnumerated = 0;                              // candidates のうち採用しなかった exact 件数
let collectDeadlineHit = false;                        // SANDBOX_COLLECT_DEADLINE_MS で打ち切ったか
for (let i = 0; i < candidates.length; i++) {          // candidates は高々 COUNT 件、file のみ
  // 0) **収集デッドライン**: 残り candidates を処理しきる前に SANDBOX_COLLECT_DEADLINE_MS を超えたら、
  //    未処理の candidates.length - i 件を omitted に積んで打ち切る（filesOmitted が deadline 分を正しく反映する）
  if (Date.now() >= collectDeadlineAt) { omittedEnumerated += candidates.length - i; collectDeadlineHit = true; break; }
  const entry = candidates[i];
  // 2) 個別ファイル上限の事前フィルタ: SANDBOX_FILE_MAX_BYTES(9MB) 超は Discord にも上げられないので読まず skip
  if (entry.size > SANDBOX_FILE_MAX_BYTES) { omittedEnumerated++; continue; } // 巨大ファイルを host に載せない第 1 防壁
  if (totalBytes + entry.size > SANDBOX_OUT_FILES_MAX_BYTES) {                 // 合計の事前チェック（metadata は信頼しすぎない）
    omittedEnumerated += candidates.length - i;        // break: 残り未訪問 candidates も全て omitted に計上
    break;
  }
  // 3) **bounded read**: entry.size が stale/詐称でも host が 1 ファイルで載せる量は per-file cap で必ず bound する。
  //    fs.read を無条件で呼ぶと全バイトを host に展開するため、高々 SANDBOX_FILE_MAX_BYTES+1 byte だけ読む:
  //    (i) SandboxFs が範囲読み（read(path,{length}) 等）を持てばそれで cap+1 byte、
  //    (ii) 無ければ in-sandbox で `head -c <cap+1>` により bounded prefix をステージングファイルへ copy してから read。
  const bytes = await readBounded(fs, entry.path, SANDBOX_FILE_MAX_BYTES); // host には高々 cap+1 byte しか載らない
  if (bytes.length > SANDBOX_FILE_MAX_BYTES) { omittedEnumerated++; continue; }   // 実 bytes が cap 超過＝size 詐称
  if (totalBytes + bytes.length > SANDBOX_OUT_FILES_MAX_BYTES) {                   // read 後の実 bytes で合計 cap を再確認
    omittedEnumerated += candidates.length - i;        // この entry 以降は全て omitted
    break;
  }
  const name = entry.path.split("/").at(-1) ?? entry.path;  // FsEntry に name は無く path のみ（attachment 名は後段の allocator で安全化）
  files.push({ name, bytes, mime: detectMime(name) });
  totalBytes += bytes.length;
}
// filesOmitted = 列挙済み candidates で落とした exact 件数（収集デッドライン超過時の未処理 candidates もここに積まれる）
// + sentinel（overflow が見えたら最低 1 件は未列挙で確実に存在）。
// これにより 51 ファイル/cap 50 のような境界でも「0 件以上」にならず「1 件以上」と正しく表示される。
const filesOmitted = omittedEnumerated + (overflowSeen ? 1 : 0);
// 未列挙分（overflow）か、デッドラインで打ち切った分があれば「N 件以上」表記。
// **デッドライン打ち切り時は omittedEnumerated に未処理 candidates が積まれるので filesOmitted >= 1 が保証**され、
// 「0 件以上」warning にはならない（万一 deadline がちょうど最後の candidate 処理後に立っても collectDeadlineHit のみ true で件数は 0、
//  その場合は未処理ゼロ＝実害なし）。
const filesOmittedAtLeast = overflowSeen || collectDeadlineHit;  // true なら未列挙/未処理分があるので「N 件以上」表記
```

ヘルパ:

- `listBounded(sandbox, dir, cap)` は **列挙数を host 側で bound する**（先頭 `cap` 件の `candidates` と、`overflowSeen = cap+1 行目(sentinel)が存在したか` の boolean を返す。**exact な総数（`wc -l`）は数えない**）。SDK が範囲付き list を持てばそれを、無ければ上記 `find ... | head -n cap+1` manifest を使い、cap+1 行目を sentinel として `overflowSeen` 判定にのみ用い candidates からは除く。これにより `fs.list` の一括返却でも、`find ... | wc -l` の全件 traversal でも host/時間コストが無制限にならない（収集 phase が `SANDBOX_COLLECT_DEADLINE_MS` を超えにくい）。
- `readBounded(fs, path, cap)` は **per-file の host メモリ上限を保証する境界付き読み取り**で、fs API の範囲読みか、無ければ in-sandbox `head -c <cap+1>` prefix を使う（合計 50 MB の `SANDBOX_OUT_FILES_MAX_BYTES` だけでは、size を詐称した単一巨大ファイルを read した時点で host メモリが破裂しうるため、per-file cap の事前 bound が必要）。
- `filesOmitted` = 列挙済み candidates のうち採用しなかった exact 件数（**収集デッドライン超過時の未処理 candidates `candidates.length - i` もここに積む**）+ `overflowSeen ? 1 : 0`、`filesOmittedAtLeast` = `overflowSeen || collectDeadlineHit`。下記「Discord 出力整形ルール」の warning TextDisplay で `filesOmittedAtLeast` のとき「N 件以上」、そうでなければ「N 件」と表示し（境界 51 ファイル/cap 50 でも「1 件以上」と正しく表記）、Discord 可視 10 cap による**追加**省略は formatter 側で別途加算する。
- 収集全体は `SANDBOX_COLLECT_DEADLINE_MS` のサブデッドライン下で行い、超過時はそれまで収集済みの `files` で打ち切り、**未処理 candidates を `filesOmitted` に加算し `filesOmittedAtLeast=true`**（`collectDeadlineHit`）にする。これにより「デッドラインで打ち切ったのに `filesOmitted=0`／『0 件以上』warning」を防ぐ（未処理分を必ず計上するので件数は実際に省いた数を下回らない）。wall timeout budget 不変条件（上記 Decisions）の収集項はこのデッドラインで bound される。
- `listBounded` / `readBounded` の範囲読み API 有無は Phase A の fs API 確認に含める。

非再帰仕様: ユーザ (LLM) には「画像やファイルは `/tmp/out/` 直下に保存してください」と tool description で誘導済 (executeCodeTool の description 内)。サブディレクトリ作成は機能上の non-goal。

(`sandbox.fs()` → `SandboxFs`（`microsandbox@0.5.4`）の API: `list(path)` → `FsEntry[]`（`{ path, kind, size, mode, modified }`、`readDir`/`isDirectory`/`name` は無い）、`read(path)` → `Uint8Array`、`readToString(path)` → string、`stat` / `exists` / `write` / `mkdir` / `remove` / `copyFromHost` / `copyToHost` 等。Phase A で allow-list 周りなど残りの細部を実コードで最終確認する)

注: handler が返す `llmResult`（foundation が `role: "tool"` content に入れる）は `ExecResult` 全体ではなく **head+tail clip された compact JSON**。詳細は下記「tool 実行ハンドラと LLM 結果整形」セクションの `toolResultForLlm` 定義を参照。バイナリ bytes は LLM 文脈に流さず、`render` 経由で Discord upload にだけ使う。Discord 側は 256 KB のフル出力 (truncate なしの場合) を `File` で受け取れる。

### Discord 出力整形ルール（Components V2）

メッセージは常に `MessageFlags.IsComponentsV2` flag を立てる。`content` / `embeds` フィールドは同時使用不可。**attachments は `files: [...]` payload upload としては引き続き送信可能** で、`File` / `MediaGallery` / `Thumbnail` component の中から `attachment://<filename>` で参照する形が公式パターン ([Discord File component](https://docs.discord.com/developers/components/reference))。一度 V2 として送信した message は legacy に edit-back できない (sticky flag)。

**`ToolRenderPayload` は attachment-capable かつ mention-safe でなければならない（updater 契約への要件として surface する）**: 生成画像/ファイルは Discord の `files: [...]` payload upload + component 側の `attachment://<name>` 参照が必須なので、`render` を「単なる V2 Container 断片」にすると binary を運べない。本 change の `codeExecutionService.formatToolBlock()` は次の **正確な shape** を返す:

```ts
// 本 change が render に要求する最小 payload（updater が Discord 送信時にこれを honor する必要がある）
interface ToolRenderPayloadShape {
  components: TopLevelComponent[];                       // V2 components 群（Container 等）
  files?: Array<{ name: string; data: Buffer | Uint8Array; contentType?: string }>; // attachment payload
  flags: MessageFlags;                                  // 少なくとも MessageFlags.IsComponentsV2 を含む
  allowedMentions: { parse: [] };                       // mention safety（下記）。updater は send/edit にこれを必ず適用する
}
```

`ToolRenderPayload` の型自体は [chat-response-v2](../chat-response-v2/design.md) / foundation updater が所有するため、**本 change は 3 点を updater 契約への要件として surface する**（foundation はこの payload を不透明に updater へ渡すだけだが、updater 実装は次を満たす必要がある）: (1) `files`（添付ファイル payload）を運べること、(2) `flags`（`IsComponentsV2`）を運べること、(3) **`allowedMentions: { parse: [] }` を render 由来の送信に必ず適用すること**（payload が `allowedMentions` を持つならそれを honor、持たない設計なら updater が tool-block 描画時に常時 `parse: []` を inject）。**この 3 点を満たさない狭い型（components+flags のみ等）では本 change の出力は安全に描画できない**ため、Phase C で foundation/chat-response-v2 側にこの payload shape の採用を確認し、`handler.render` → updater → Discord send/edit までの **file upload + allowedMentions passthrough を検証する test** を入れる（後述 Tasks）。`/run`（updater を介さない）は同じ payload をそのまま `interaction.editReply({ ...payload })` の message options に流用し、`allowedMentions` も自前で付ける。

**全送信で `allowedMentions: { parse: [] }` を強制**。sandbox stdout に `@everyone` / `<@&roleId>` が含まれても発火しないようにする (TextDisplay は legacy embed.description と違いメッセージ本文と同じ ping 挙動)。**LLM tool 経路では send を行うのは updater なので**、mention safety は payload に `allowedMentions` を載せる（または updater が常時 inject する）契約に依存する点が `/run` 経路（本 change が直接 `editReply` する）との違いで、上記 (3) はこのギャップを埋めるための要件。

#### 構造テンプレート

```text
Container (accent color: green/yellow/red = success/truncated/error)
├ TextDisplay  "▶ python · 1.23s · exit 0"                ← ヘッダ行（exitCode が null〔never-started / kill〕なら "exit —" または systemError 種別を表示）
├ Separator (small)
├ TextDisplay  "```\n<stdout>\n```"                       ← ヘッダ+stdout+stderr+フッタの TextDisplay 合計 ≤ 3800 字に収まる時のみインライン
│                                                            (合計超過時は stdout/stderr を File に回す)
├ TextDisplay  "**stderr**\n```\n<stderr>\n```"           ← stderr あれば (上記の合計予算を共有)
├ MediaGallery [image_1.png, image_2.png, ...]            ← /tmp/out/*.{png,jpg,jpeg} のみ (SVG 除く)
├ File [stdout.txt]                                       ← stdout が 3800 字超 or truncate あり
├ File [stderr.txt]                                       ← 同様
├ File [image_N.svg]                                      ← SVG / その他形式は MediaGallery ではなく File
└ Separator (small)
```

末尾 `Section` + `Button` は **v1 では設置しない** (Re-run 機能を v1 から外したため、Section に置く意味のある accessory がない。Section は accessory required なので無理に付けるとレイアウトが壊れる)。

**component 数は 2 つの上限を両方 budget する**: (1) **message 全体 ≤ 40 component**（ネスト含む）と (2) **1 Container の子 component 数 ≤ 10**（`CONTAINER_CHILD_COMPONENT_MAX = 10`。installed `discord-api-types` の `APIContainerComponent` doc が "holds up to 10 components" / "Up to 10 components of the type action row, text display, section, media gallery, separator, or file" と明記）。テンプレートは単一 Container に header / separator / stdout / stderr / MediaGallery / 個別 File 群 / warning / footer を詰めるため、ファイル card が増えると **Container の 10 子上限**に先に当たりうる。そこで **Container の子数が 10 に達する前（11 個目を入れる前）に、個別 `File` / 追加 `MediaGallery` を主 Container の外（**同一メッセージ内の** 別 top-level component）や追加 Container へ spill** する（`ToolRenderPayloadShape` は単一メッセージ payload〔`components` 配列 1 本〕なので、spill 先は同じ `components` 配列内の追加 top-level component / 追加 Container に限る。**follow-up メッセージへの分割はしない** — payload 型が複数メッセージを表現できず、`/run` も単一 `editReply` で送るため）。`File`/`MediaGallery` を主 Container 内に必ず入れる前提にはしない。**それでも単一メッセージの 40 component / 10 attachment cap を超える分は drop し、warning TextDisplay 1 件で省略件数を表示**（host 収集の `filesOmitted` と合算。下記「可視 attachment 個数上限」参照）。**`CONTAINER_CHILD_COMPONENT_MAX` (=10) と 40 message cap・10 attachment cap の 3 つを単一メッセージで満たす最小構成**にレイアウトを組み、Phase A で discord.js v14.26.x の builder バリデーション挙動（cap 超過時の throw 有無）を確認する。

#### 整形ルール詳細

1. **短文** (**ヘッダ + stdout + stderr + フッタの TextDisplay 合計が 1 message 4000 字制約に収まる**＝安全マージン込みで合計 ≤ 3800 字。fence ` ``` ` の overhead も計上): すべて `TextDisplay` + `MediaGallery` でインライン表示。bitmap 画像の枚数は固定上限を設けず、下記 3 の動的 `bitmapLimit = min(10, 残 attachment 枠)` に従う（stdout/stderr がインラインなら最大 10 枚）。stdout と stderr を両方インラインに載せる場合は両者で合計予算を共有し、超過分（大きい方優先で）を `File` に回す。
2. **長文 / truncate あり**: stdout/stderr を `File` (`stdout.txt`/`stderr.txt`) として attachment card 化、`TextDisplay` には先頭 N 行 + "... (attached output; truncated if host cap was hit)" を表示。host 側 256 KB cap (`SANDBOX_OUTPUT_MAX_BYTES_HOST`) を超えた場合は attachment 自体も truncate されていることを明示する文言を入れる。
3. **bitmap 画像が多い場合**: `MediaGallery` (公式仕様で 1〜10 枚) に収める。枚数上限は**固定ではなく動的**で `bitmapLimit = min(10, 残 attachment 枠) = min(10, 10 − stdout/stderr offload 件数)`。両方 offload された worst case でのみ `bitmap ≤ 8`、stdout/stderr が両方インラインなら最大 10 枚。超過分は (a) `File` での代替添付か (b) warning TextDisplay の省略表示 に振り分ける（下記「可視 attachment 個数上限」の単一 budget に従う）。
4. **SVG / その他形式 (`.html`, `.csv`, `.json`, `.bin` 等)**: 全て `File` で添付。SVG は Discord client での inline 描画挙動が安定しないため `MediaGallery` には入れない。
5. **可視 attachment 個数上限（単一 budget の共有）**: Discord API の `files: [...]` 配列の attachment 数は実用上 10 件/メッセージが上限 (`files` ≤ 10 が community で報告される common cap)。**stdout.txt / stderr.txt の offload・MediaGallery の bitmap 画像 item・個別生成 File は、すべてこの同一の 10 attachment budget を共有する**（MediaGallery の各画像も 1 file upload として消費する）。割当の優先順位は **(a) offload された stdout.txt / stderr.txt（≤2、長文/truncate 時のみ・コード実行の主出力なので最優先）→ (b) bitmap 画像（残枠を MediaGallery、ただし MediaGallery は最大 10 item）→ (c) その他生成 File** の順に 10 枠を埋め、溢れた分（Discord 可視 cap による省略）を host 収集での `ExecResult.filesOmitted` と合算し、warning TextDisplay 1 件で「N 件のファイルが省略されました (host 側収集は最大 50 まで、Discord 表示は計 10 attachment まで)」と表示する（`ExecResult.filesOmittedAtLeast` が true の場合〔収集が列挙 cap / 収集デッドラインで打ち切られた場合〕は「N 件以上」と表記する）。この 10 attachment cap に加え、**message 全体 ≤ 40 component と 1 Container ≤ 10 子（`CONTAINER_CHILD_COMPONENT_MAX`）の両方**を満たす（上記「構造テンプレート」の component budget 注記参照。単一 Container に詰めると 10 子上限に当たりうるので 11 個目の前に spill する）。**Phase A の実装着手時に Discord API の正確な attachment 上限を re-verify**（Container 子数上限は installed `discord-api-types` で 10 と確認済み）、attachment 上限が 10 未満だったら spec 側を絞る。
6. **例外** (`systemError`: タイムアウト / OOM / sandbox 起動失敗 / queue_timeout): Container accent を red、`TextDisplay` にエラー種別 + 原因。これらは正常 `ExecResult`（`systemError` 入り）なので同じ整形経路に乗る（cancel/foundation-timeout は handler が throw するためここには来ない＝foundation 側の表示）。
7. **stdout/stderr の host 側上限**: 各 256 KB (`SANDBOX_OUTPUT_MAX_BYTES_HOST=262144`)、bounded capture で受信時点で上限を効かせる（上記「stdout/stderr の bounded capture」注記の方式）。`truncated.stdout/stderr` を立てて UI に明示。
8. **`/tmp/out/*` の host 側収集・転送上限**: 合計 50 MB (`SANDBOX_OUT_FILES_MAX_BYTES`)、最大 50 ファイル (`SANDBOX_OUT_FILES_MAX_COUNT`)。超過分はリストから drop（host が読み取り Discord に上げる量の保護。sandbox 内 disk fill 防止ではない）。
9. **個別ファイルの Discord upload 上限**: guild boost level に応じる (L0=10MB / L2=50MB / L3=100MB)。`SANDBOX_FILE_MAX_BYTES` (デフォルト 9 MB、L0 安全マージン) を超えるファイルは `File` ではなく warning TextDisplay に置換 ("file too large: N MB > limit M MB")。Bot 起動時に自 guild の boost level を取得して上書きするのは v1.1 で対応、v1 は固定値。
10. **attachment 名の安全な採番（collision / 不正名対策）**: Discord に上げる `files: [...]` の name は component 側 `attachment://<name>` から参照されるため、**一意かつ安全**でなければならない。問題は (a) formatter が生成する `stdout.txt` / `stderr.txt` と、sandbox basename（例: ユーザが `/tmp/out/stdout.txt` を生成）の**衝突**、(b) sanitize 後に重複しうる basename、(c) URL/参照に不正な文字。そこで **専用 allocator** で attachment 参照名を採番する: 生成出力は予約プレフィクス（`exec-stdout.txt` / `exec-stderr.txt`）、sandbox ファイルは `out-001-<sanitized-basename>` のように連番プレフィクス + sanitize（英数・`.`・`-`・`_` 以外を `_` 化、長さ制限）し、衝突時は連番で de-dup する。**ユーザ向け表示名（File component の title）と attachment 参照名は分離**してよい（表示は元 basename、参照は安全採番）。`attachment://` 参照と `files[].name` は必ず採番後の安全名で一致させる。

| 上限 | 値 | 意味 |
|---|---|---|
| `SANDBOX_OUTPUT_MAX_BYTES_HOST` | 256 KB | host NAPI が sandbox stdout/stderr を受け取るときの truncate ラインで、buffer overrun 防止 |
| `SANDBOX_OUT_FILES_MAX_BYTES` | 50 MB | `/tmp/out/*` の合計サイズ、超過は drop |
| `SANDBOX_OUT_FILES_MAX_COUNT` | 50 | `/tmp/out/*` のファイル個数、超過は drop |
| `SANDBOX_FILE_MAX_BYTES` | 9 MB | Discord に upload する個別ファイルの上限 |

### /run スラッシュコマンド + Modal フロー（dev/test only）

リリース時には command registration から除外（`NODE_ENV !== "production"` のときだけ `commandDefinitions` に push）。production guild からは見えない。実装時の手動テスト + integration test で利用。

```text
1. /run                                              ← slash command (option なし)
2. Bot: Modal を showModal() で開く
   ModalBuilder (Components V2 modal)
     ├ Label "Language"
     │   └ StringSelectMenuBuilder
     │       options: [python, node, bash]
     ├ Label "Code"
     │   └ TextInputBuilder (paragraph, maxLength=min(4000, SANDBOX_CODE_MAX_CHARS)=4000)  ← Discord TextInput 上限 4000
     └ Label `Timeout sec (optional, max ${effectiveTimeoutSecMax})`  ← 固定 120 ではなく導出値を埋め込む
         └ TextInputBuilder (short, required=false)
3. ユーザ submit
4. interactionCreate handler が ModalSubmitInteraction を捕捉
5. **`deferReply()` (非 ephemeral)** → `runCodeExecution({ ...args, networkAllowed: false })`（IClientTool.handler と同じ共有ヘルパ。**`/run` v1 は常に no-network**: modal にネット制御を置かず `networkAllowed: false` 固定で呼ぶ。共有ヘルパの引数は `CodeExecArgs & { networkAllowed: boolean }` なので明示が必須）→ `codeExecutionService.formatToolBlock(result)` → Components V2 メッセージで editReply
```

`/run` は **foundation の `runToolLoop` / `IClientTool.handler` を経由しない**（`IToolContext` / `meta` / updater を持たないため）。代わりに上述の共有ヘルパ `runCodeExecution()` と `codeExecutionService.formatToolBlock()` を直接呼ぶ。これにより sandbox 実行ロジックと描画ロジックを LLM 経路と共有しつつ、foundation 固有の文脈には依存しない。

**`/run` のゲートは LLM tool 経路とは別**: `/run` は `sandboxFeatureEnabled()`（`SANDBOX_ENABLED` + prewarm readiness）のみを参照し、**guild の `code_execution_enabled` toggle は意図的にバイパスする**。これは `/run` が dev only（`NODE_ENV !== "production"` でのみ登録、本番 guild には未公開）の開発者テスト用コマンドで、guild 単位の機能 ON/OFF（= LLM が自律実行してよいかの管理者同意）とは別概念のためである。production では `commandDefinitions` に push されないので一般ユーザは到達できないが、dev 環境で誤って広い権限のサーバに置いた場合に guild toggle をバイパスしたまま任意コード実行されないよう、**`/run` は設計として管理者限定にする**: command 定義に **`setDefaultMemberPermissions(PermissionFlagsBits.Administrator)`** を付け（`@everyone` から不可視・実行不可にする）、ハンドラ先頭でも `member.permissions.has(Administrator)` を再確認して非管理者は拒否する（二段確認）。これにより「dev-only かつ管理者のみ」が二段階同意ゲートの代替になる。LLM tool 経路（`execute_code` / `_with_network`）は従来どおり guild の 2 toggle を `isEnabled` で必ず評価する。

Discord UI の制約と採用判断:

- **Modal in modal の select**: 2025-08-25 から `Label` で wrap すれば `StringSelect` 等を modal に入れられる（[Discord API change log](https://docs.discord.com/developers/change-log)）。discord.js では `LabelBuilder` を `modal.addLabelComponents(label)` で追加するのが推奨 API（旧 `addComponents(ActionRow)` パターンは legacy 扱い）。これにより slash option を削れて UX 簡潔。
- **RadioGroup の代替案**: 2026-02 から modal 内に `RadioGroup` / `Checkbox` が追加され、discord.js v14.26.x の `LabelBuilder.setRadioGroupComponent()` で利用可能。言語の 3 択（python/node/bash）は排他選択なので `StringSelect` より `RadioGroup` の方が意図が明確。v1 は `StringSelect` のままで可、UI 改善候補として記録。
- **Slash command string option (旧案)**: 1 行入力、改行は `\n` 手入力。modal に統合したので不要。
- **メッセージ添付 (.py / .js)**: 意図検知が暗黙的でコマンド誤反応リスク、却下。
- **コードブロックを含むメッセージ自動検知**: 同上、却下。
- **Private thread でのセッション隔離**: 検討したが v1 ではコマンド未公開のため不要。LLM tool call 経路はチャット文脈の中で結果を返すのが自然で thread 化のメリット薄。Phase 2 候補。
- **Defer の ephemeral**: `deferReply({ flags: MessageFlags.Ephemeral })` を使うと **以降の `editReply` も ephemeral 固定**で出力が消える (`followUp` で別途公開メッセージを送る必要がある)。dev/test 用途でも結果を残して回帰確認したいので、**`deferReply()` を非 ephemeral で打つ**。
- **`ephemeral: true` (legacy)**: discord.js v14.19 で deprecated、`flags: MessageFlags.Ephemeral` を使う。本 spec 内ではどこにも ephemeral を使わない。

### tool 実行ハンドラと LLM 結果整形

streaming マルチターンループ（delta 蓄積・`accumToolCalls` / `normalizedCalls` / synthetic id / overflow / `MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN` / `role:"tool"` 整合）は **[tool-calling-foundation](../tool-calling-foundation/design.md) の `runToolLoop()` が一手に担う**。旧設計でここに書いていた擬似ループは foundation 側へ移管済みで、本 change では再掲しない。本 change が foundation に渡すのは次の 2 点だけ:

1. **`handler(args, ctx, signal, meta)`** — `sandboxService.execute({ ..., signal })` を呼ぶ。**2 種類の停止を区別する**:
   - **foundation `signal` の abort（request cancel / per-tool wall timeout の双方）**: `ExecHandle.kill()` → `sandbox.kill()` の killable isolation を発火し、cleanup 後に handler は**正常結果（`{ llmResult, render }`）を返さず generic な abort（`AbortError` 等）を throw する**（stale な正常結果でターンを進めない）。**foundation の分類は本 tool が決めない**: foundation が自身の race 状態で `request cancel > timeout > handler 結果` を判定し、request cancel なら `{status:'cancelled'}` + cancellation tool 結果、per-tool timeout なら bounded な error tool 結果を**自分で生成**する。本 tool は signal の cancel/timeout を区別せず、`signal.aborted` を見たら一律 kill + throw すればよく、**throw する error の型/名前は foundation の分類に影響しない**（「実行結果不明」セマンティクス。Decisions「Tool の timeout/cancel 契約」参照）。
   - **args の `timeout_sec`（sandbox 内タイムアウト）**: 同じく kill するが、これは想定内の実行結果なので **reject せず** `systemError.kind:"timeout"` を載せた正常な `ExecResult` を返し、下記 `{ llmResult, render }` 経路に流す。
   - 正常完了時の戻りは `{ llmResult, render }`:
     - `llmResult` = `JSON.stringify(toolResultForLlm(execResult))`（**文字列**。head+tail clip、file bytes 除外）。
     - `render` = `codeExecutionService.formatToolBlock(execResult)`（**attachment-capable** payload: V2 components + 添付ファイル payload + flags。binary file bytes はここで Discord upload に渡す）。foundation 契約では `render?` は任意だが、**本 tool は正常完了時は必ず `render` を返す**（より強い保証）。abort/foundation-timeout 経路は上記のとおり throw するので、この handler からは結果も `render` も返らない。
2. **`validate(args)`** — `language` enum / `code` 長さ / `timeout_sec` 範囲を runtime 検証。不適合は foundation が tool を実行せず error 結果を返す。

foundation の流れ（参考。本 change は関与しない）: `runToolLoop()` が delta から `tool_calls` を蓄積 → `finish_reason:"tool_calls"` で正規化 → assistant message を先に push → 各 client call を sequential dispatch（`isEnabled` 再評価 → `validate` → `handler` を `signal` 付きで呼ぶ → `role:"tool"` を id 整合で push → updater に `render` 反映）→ 次ターン。begin/end の progress 表示（「コード実行中...」）も foundation の updater フックで行われ、本 change はその描画内容（`render`）を供給するだけ。

`toolResultForLlm()` 定義 (LLM context 圧迫対策で head+tail clip。本 change が所有する serialize ロジック):

```ts
function toolResultForLlm(r: ExecResult) {
  return {
    stdout: clipHeadTailBytes(r.stdout, SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES),  // 8 KB head+tail
    stderr: clipHeadTailBytes(r.stderr, SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES),  // 8 KB
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    truncated: r.truncated,
    files: r.files.map(f => ({ name: f.name, size: f.bytes.length, mime: f.mime })),
    filesOmitted: r.filesOmitted,  // host 収集で落とした exact 件数を LLM にも伝える（生成し直しの判断材料）
    filesOmittedAtLeast: r.filesOmittedAtLeast,  // 列挙 cap 超で「これ以上ある」を LLM に伝える
    systemError: r.systemError,
  };
}

function clipHeadTailBytes(s: string, cap: number): string {
  // 環境変数は byte 単位、JavaScript の string.length は UTF-16 code units なので
  // 日本語等の多バイト文字を含む場合 .slice(N) では byte 上限を超えうる。
  // TextEncoder で byte 計測し、head/tail を半分ずつ collect する。
  const enc = new TextEncoder();
  const totalBytes = enc.encode(s).length;
  if (totalBytes <= cap) return s;
  // 返り値全体（head + marker + tail）が cap を超えないよう、marker の byte 数を先に予約する。
  // marker は truncate byte 数を含むので、まず固定長プレースホルダで予算を見積もってから
  // head/tail を切り、実際に省いた byte 数で marker を確定する（省略数 = total - 実 head - 実 tail）。
  // omitted は高々 totalBytes なので marker の数値部は String(totalBytes).length 桁に収まる。
  // 固定 placeholder（旧 999999999=9桁）ではなく実際の最大桁数で予約し、`<= cap` 不変条件を一般に成立させる
  // （省略数が 10^9 byte を超えても破綻しない）。
  const maxDigits = String(totalBytes).length;
  const markerReserve = enc.encode(`\n...[truncated ${"9".repeat(maxDigits)} bytes]...\n`).length;
  // cap が marker より小さい病的ケース: head/tail を一切残せないので marker 自体を cap に clip して返す
  // （`<= cap` 保証を破らない）。env override で SANDBOX_TOOL_RESULT_* を marker 長未満にした場合の安全弁。
  // envVars.ts のローダ側でも起動時 validate するが、ここでの markerReserve は runtime の totalBytes 依存なので
  // **ローダは「想定最大入力」での marker 長**で判定する: clipHeadTailBytes への入力 stdout/stderr は host capture で
  // 既に SANDBOX_OUTPUT_MAX_BYTES_HOST(256KB) に bound 済みなので omitted ≤ 256KB（= maxDigits 6 桁）。よってローダは
  // `SANDBOX_TOOL_RESULT_* >= markerReserveFor(SANDBOX_OUTPUT_MAX_BYTES_HOST)`（6 桁プレースホルダでの marker byte 長）
  // を起動時に validate して早期に弾く（runtime の `cap < markerReserve` フォールバックは二重の安全弁）。
  if (cap < markerReserve) return clipMarkerToCap(`\n...[truncated ${totalBytes} bytes]...\n`, cap);
  const budget = Math.max(0, cap - markerReserve);
  const half = Math.floor(budget / 2);
  const head = sliceFromHeadByBytes(s, half);   // 実際に残す head（文字境界で half byte 以内）
  const tail = sliceFromTailByBytes(s, half);   // 実際に残す tail
  const omitted = totalBytes - enc.encode(head).length - enc.encode(tail).length;
  return head + `\n...[truncated ${omitted} bytes]...\n` + tail;  // 全体 byte 数 ≤ cap を保証
}
// sliceFromHeadByBytes / sliceFromTailByBytes は文字境界を尊重して切る (実装は省略)
```

この per-stream head+tail clip は **本 change 固有の関心**（stdout/stderr の中身を頭と尾だけ残す意味的圧縮）であって、foundation が `llmResult` 全体にかける UTF-8 安全な最大 byte clip（context 肥大の最終防波堤）とは目的が別。両者は順に適用され、二重の安全弁になる（foundation の clip は `llmResult` 文字列**全体**に UTF-8 安全な最大 byte cap をかける不透明な防波堤〔[tool-calling-foundation](../tool-calling-foundation/design.md) は head+tail clip と定義〕で、`stdout`/`stderr` という個別フィールド単位の意味的圧縮はしないため、フィールドごとの head+tail 圧縮は本 change 側でやる必要がある）。

本 change 側の出力は **stdout/stderr 各 8 KB（これは `JSON.stringify` 前のフィールド単位 preview cap）+ 固定フィールド（exitCode/durationMs/files メタ等）**に収まるよう設計している。ただし `JSON.stringify(toolResultForLlm(...))` は文字列を escape する（`"`→`\"`、改行・制御文字→`\n`/`\uXXXX`）ため、**直列化後の `llmResult` byte 数は raw フィールド byte の最大 ~6 倍（制御文字主体の病的入力で 1 byte→`\uXXXX` 6 byte）+ files メタ（≤50 件 × 数十 byte）まで膨らみうる**。したがって「8 KB cap だから foundation 最終 clip は発火しない」とは**断定できない**: 典型出力では `SANDBOX_TOOL_RESULT_*` を十分小さく保つことで発火しないが、病的入力では直列化後が foundation の最大 byte cap を超え clip が発火しうる。**本 change はこの不発火に依存しない**（直列化後の hard ceiling は foundation の opaque な最大 byte clip が担う）。万一発火した場合、`role:"tool"` content は JSON として壊れうる（head+tail clip で中間が落ちる）が、foundation は `llmResult` を**不透明な文字列**として扱い JSON valid を要求しないため protocol 整合は崩れない（LLM 側の解釈精度が落ちるだけ）。本 change は最終 content が valid JSON であることに依存しない。

### 環境変数

| 名前 | デフォルト | 用途 |
| ---- | ---------- | ---- |
| `SANDBOX_ENABLED` | `false` | 機能全体の kill switch (false なら DB toggle に関わらず tools 配列に追加しない) |
| `SANDBOX_MAX_CONCURRENT` | `4` | 同時 sandbox 起動上限 (キュー入り、5 秒超で `systemError.kind:"queue_timeout"` の正常 ExecResult を返す) |
| `SANDBOX_DEFAULT_CPUS` | `1` | per-sandbox CPU |
| `SANDBOX_DEFAULT_MEMORY_MIB` | `512` | per-sandbox RAM |
| `SANDBOX_NETWORK_ALLOWLIST` | `pypi.org,files.pythonhosted.org,registry.npmjs.org,objects.githubusercontent.com` | `_with_network` ツール経路で許可される egress ホスト |
| `SANDBOX_OUTPUT_MAX_BYTES_HOST` | `262144` (256 KB) | host NAPI で受け取る stdout/stderr の truncate 閾値 |
| `SANDBOX_OUT_FILES_MAX_BYTES` | `52428800` (50 MB) | `/tmp/out/*` の合計サイズ、超過分は drop |
| `SANDBOX_OUT_FILES_MAX_COUNT` | `50` | `/tmp/out/*` の収集ファイル個数 (Discord 表示は別途、stdout/stderr offload・MediaGallery 画像・File が共有する**計 10 attachment** budget。bitmap は stdout/stderr offload 後の残枠を取る) |
| `SANDBOX_FILE_MAX_BYTES` | `9437184` (9 MB) | Discord upload する個別ファイルの上限 (L0 安全マージン) |
| `SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES` | `8192` (8 KB) | LLM への tool result で stdout を head+tail で clip する上限 |
| `SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES` | `8192` (8 KB) | 同 stderr 用 |
| `SANDBOX_CODE_MAX_CHARS` | `100000` (100k 文字) | `code` 引数の最大文字数。JSON Schema `code.maxLength` / runtime `validate` / `/run` modal が共有（`/run` modal は Discord TextInput の 4000 字上限でさらに制限される） |
| `SANDBOX_BOOT_DEADLINE_MS` | `20000` (20s) | `create()`→ready の boot サブデッドライン。超過は `systemError.kind:"boot_failed"` の正常 ExecResult。wall budget の boot 項を bound |
| `SANDBOX_COLLECT_DEADLINE_MS` | `15000` (15s) | `/tmp/out` 収集（列挙 + bounded read）のサブデッドライン。超過時はそれまで収集済みの files で打ち切り `filesOmitted` に計上。wall budget の収集項を bound |
| `SANDBOX_TEARDOWN_DEADLINE_MS` | `10000` (10s) | **VM 停止（`stopAndWait()`/`sandbox.kill()`）+ それに続く `removePersisted()` 試行**の handler 同期待ちサブデッドライン。VM 停止が確定すれば permit を解放し、`removePersisted()` だけが超過したら handler を即 settle して残り `removePersisted()` を **permit 非保持**の detached cleanup へ切り出す（「teardown 超過の単一ステートマシン」(2)）。VM 停止自体を確定できない場合は permit を解放せず fail-closed (3)。wall budget の teardown 項を bound する（保証するのは VM 停止 + removePersisted の同期試行までで、`removePersisted()` の完了は保証しない。detached 側の有界リトライ予算は別） |
| `MSB_HOME` | `/data/microsandbox` (コンテナ絶対パス) | NAPI が参照する microsandbox ホームディレクトリ。Docker named volume をここにマウント |

### セキュリティ・観測

- 既存の `metrics.ts`（admin-endpoints で導入予定）に `sandbox_started_total` / `sandbox_failed_total` / `sandbox_active` / `sandbox_queue_wait_ms` / `code_exec_duration_ms` を追加。
- ログ: 実行 1 件ごとに `{ guildId, channelId, userId, lang, code_hash, exit, duration_ms, network, files_count, files_bytes }` を info で出力。コード本体は **ログしない** (プライバシー + token 削減)。
- `code_execution_enabled = 0` の guild は両 tool の `isEnabled(ctx)` が `false` を返し、foundation の `buildTools(ctx)` から除外される。foundation 側で **client+server 結合配列が空なら `tools` も `tool_choice` も request body から omit して** OpenRouter に送信する（一部上流プロバイダは `tools: []` + `tool_choice` を invalid と判定。omit 判定・送信は foundation の責務）。LLM 側に tool が見えないので「無効化されています」を作文させる必要なし。foundation は dispatch 時にも `isEnabled` を再評価するので、無効 guild でモデルが既知 tool 名を捏造しても実行されない。
- `code_execution_enabled = 1, code_execution_network_enabled = 0` の場合は `execute_code` の `isEnabled` のみ true（`execute_code_with_network` は false）。二段階ゲートは 2 つの `isEnabled` 実装で表現する。
- `SANDBOX_ENABLED = false` の場合は両 tool の `isEnabled` が常に false（guild 設定に関わらず expose されない）。
- `sandboxFeatureEnabled()`（両 tool の `isEnabled` と `/run` が参照するゲート）は `SANDBOX_ENABLED=true` **かつ prewarm readiness 完了**で初めて true。起動直後 prewarm 未完の間は tool を expose せず `/run` も拒否し、cold image pull を実 tool call の 180s budget に持ち込まない（Decisions「prewarm readiness gate」参照）。
- mention safety: 全 V2 送信 (`channel.send` / `message.edit` / `interaction.editReply` / `interaction.followUp` / `message.reply` 全て) で `allowedMentions: { parse: [] }`。`message.reply()` 経路を使う場合は **追加で `allowedMentions.repliedUser: false`** を併用 (上書きでない限り元投稿者を ping するため)。コードや stdout に書かれた mention 構文 (`<@!1234>` 等) は表示はされるが ping は発火しない。

### 参照

- microsandbox README & docs: <https://github.com/superradcompany/microsandbox>
  - `sdk/node-ts/README.md` — NAPI SDK 概要、detached mode
  - `docs/networking/security-model.mdx` — default-deny egress 仕様
  - `docs/configuration.mdx` — `sandbox_defaults` / paths
  - `scripts/install.sh` — glibc ≥ 2.39 要件（`LINUX_GLIBC_MIN_VERSION="2.39"`）、musl 拒否
- [tool-calling-foundation](../tool-calling-foundation/design.md) — `IClientTool` / `ToolRegistry` / `runToolLoop()`・timeout/cancel の killable isolation 契約・空 tool omit
- 着想元: hermes-agent のセキュリティモデル（人手承認はヒューリスティックで封じ込めではない / 封じ込めは sandbox が担う）
- OpenRouter tool calling: <https://openrouter.ai/docs/guides/features/tool-calling>
- OpenRouter models filter: `GET /api/v1/models?supported_parameters=tools`
- discord.js Modal: <https://discordjs.guide/interactions/modals.html>
- Discord Components V2 (2025-04-22 リリース): <https://docs.discord.com/developers/components/reference>
- discord.js PR #10781 (Components V2 in v14): <https://github.com/discordjs/discord.js/pull/10781>
- discord.js `LabelBuilder`（modal 内 select / RadioGroup / Checkbox、v14.25.1+、現行 `^14.26.4`）: <https://discord.js.org/docs/packages/discord.js/14.26.4/LabelBuilder:Class>
- Discord Developer Change Log: <https://docs.discord.com/developers/change-log>

## Tasks

### Phase 0: ホスト検証（実装着手の前提条件）

- [ ] Proxmox LXC conf に `/dev/kvm` パススルー + `nesting=1` 設定
- [ ] Coolify Bot コンテナのベースを決定し起動確認。**先に `ldd --version` で glibc ≥ 2.39 を確認**（`oven/bun:1-debian`=bookworm は 2.36 で不足の可能性。不足なら `ubuntu:24.04` ベース等に切替）
- [ ] Bot コンテナ内で `ls -l /dev/kvm` と `npx microsandbox run debian -- echo hi` が成功することを確認
- [ ] **Bun ランタイムで `require("microsandbox")` が NAPI エラーなくロードできることを smoke test**（Bun の NAPI 実装が microsandbox バインディングと互換か）
- [ ] **sandbox の disk/inode bound を検証**: sandbox 内で `dd`/`fallocate` で大量書き込みしても host disk が枯渇しないこと（rootfs が有界な ephemeral disk か）を確認し、builder の disk 上限オプション有無を調べる。無ければ `MSB_HOME` volume / tmpfs に size quota を課す方針を確定（untrusted 実行を enable する前提条件）
- [ ] **`sandbox.kill()` の有界性・確実性を検証（killable isolation の前提）**: 実行中の VM に対する `sandbox.kill()`（および**名前指定 kill**）が**有界時間で確実に VM を破壊**する（プロセス + egress が止まる）ことを確認。`create()` がハングしうるか、ハング中の生成 VM を**名前指定で abandon/kill できるか**も確認（create-abandon 状態の前提）。保証できない場合は当該経路を degraded/fail-closed にする方針を確定（「permit 強制解放で sweep 任せ」は安全契約に反するため不可）
- [ ] 失敗時の判定: Deploy-Plan A 中止 → Deploy-Plan B（別 Proxmox VM + HTTP wrapper）に切替方針を再起票

### Phase A: sandbox 基盤

- [ ] `microsandbox` 依存追加（v0.5.4）。`discord.js` は現行 `^14.26.4`（`LabelBuilder` は v14.25.1+）で対応済みのため bump 不要
- [ ] `/data/microsandbox` を named volume 化 (Coolify / docker-compose 設定)
- [ ] DB マイグレーション: `code_execution_enabled` + `code_execution_network_enabled` 2 カラム追加
- [ ] microsandbox SDK の network 設定（`disableNetwork()` / `network((b)=>...)` callback 内で **default-deny + `Rule.allowDns()` + allow-list ドメインの `Rule.allowEgress(Destination.domain(...))`** を適用する形）を実コードで最終確認（API 名は `microsandbox@0.5.4` の型のとおり。callback 内の policy 適用形のみ未確定）
- [ ] microsandbox SDK の `sandbox.fs()` → `SandboxFs.list()` / `read()` / `readToString()` と `FsEntry { path, kind, size, mode, modified }` の実挙動を実装時に最終確認
- [ ] `sandboxService` 実装 (`prewarmImages` (create → stopAndWait → removePersisted、finally で掃除) + `execute` (UUID name 採番、**明示的 abort-aware カウンティング semaphore で同時数キュー**〔auto-release-on-settle の limiter は使わない: permit は物理クリーンアップ完了まで保持〕、5 秒超で `systemError.kind:"queue_timeout"` の正常 ExecResult を返す〔throw しない〕、`signal` を受けて **abort-aware queue**: permit 取得を `race([acquire(), queueTimeout(5s), abortPromise])` で待ち、待機中 abort なら**即 settle して throw** + pending acquire を待ちキューから除去/skip（後で解決しても sandbox を作らない）、acquire 直前と `create()` 直前にも `signal.aborted` を再確認、**create() への abort race**: create promise を try 外で保持し、boot deadline / abort で create 未 resolve のまま脱出する前に **detached cleanup 継続 `void createPromise.then(cleanupCreatedSandbox).catch(log)` を登録**してから throw（finally では遅れて生まれた sandbox を掃除できない）、create が handler 内で resolve したら直後に `signal.aborted` 再確認 + kill/removePersisted。listener は必ず cleanup。各 phase は boot/collect/teardown サブデッドライン下で実行。**同時数 permit（Bottleneck slot 相当）は handler return ではなく sandbox ライフサイクルに紐づけ、create resolve/reject + detached cleanup 完了まで保持してから解放**（abort 連打で orphan create が N を超えないように）))
- [ ] stdout/stderr の **bounded capture** 実装（SDK の streaming/逐次受信 cap か sandbox 内 file リダイレクト + `head -c` ラッパか、Phase A で確定した方式。post-hoc host truncate にはフォールバックしない）と `truncated` フラグ反映
- [ ] **`/tmp/out/*` のファイル収集**（sandboxService の責務、sandbox 破棄前・non-recursive・file entry のみ・**bounded enumeration（`listBounded`：先頭 `COUNT` 件の candidates + `overflowSeen` boolean〔cap+1 行目 sentinel〕。`wc -l` の全件 traversal はしない）**・**per-file bounded read（`readBounded`）で host メモリ保護**・`SANDBOX_OUT_FILES_MAX_*` で合計 cap・`filesOmitted = candidates で落とした exact 件数 + (overflowSeen?1:0)` / `filesOmittedAtLeast = overflowSeen`・**`SANDBOX_COLLECT_DEADLINE_MS` のサブデッドラインで打ち切り**）を `ExecResult.files` / `filesOmitted` / `filesOmittedAtLeast` に載せる
- [ ] Bot 起動時に 3 言語 image を prewarm (`SANDBOX_ENABLED=true` 時のみ)。**`await prewarmImages()` 完了で readiness フラグを立て、`sandboxFeatureEnabled()` がそれを参照**（prewarm 未完の間は tool を expose せず `/run` も拒否）。prewarm 失敗は v1 では **feature 全体を fail-closed**（per-language 部分無効化はしない）
- [ ] **2 つの kill 経路を検証**: (A) `args.timeout_sec` 到達 → **ラッパ内 watchdog による in-VM group kill + メタ flush**（`setsid` プロセスグループを `timeout(1)` 相当で `kill -- -<pgid>`→猶予後 SIGKILL→reap、ラッパは生存して `$?`/`truncated` を capture ファイルへ書く。host の `ExecHandle.kill()` は冗長 backstop）→ host は backstop 内のラッパ返却を待って **収集** → teardown → `systemError.kind:"timeout"` の正常 ExecResult に**部分 stdout/`/tmp/out` が載る**こと（**子プロセスが収集ウィンドウ中に `/tmp/out` を書き換え/egress 継続しないこと**・**ラッパが user プロセス kill 後も exit メタを flush できること**も確認。in-VM watchdog + メタ flush を確立できなければ (A) を host `sandbox.kill()` + 収集スキップへフォールバック）、(B) `signal` abort → `ExecHandle.kill()` → **即 `sandbox.kill()`（収集スキップ）** → `removePersisted()` → throw、を区別して統合動作確認。加えて**キュー待機中 abort で handler が即 settle し pending acquire（semaphore 待ち）が skip される**こと（クリーンアップ不変条件 + 「cancel された call が後で sandbox を起動しない」+ **「handler settle 後に create() が遅れて resolve したケースで detached cleanup が sandbox を kill/removePersisted し leak しない」** + **「abort/boot-timeout を連打しても active + 生成中 + teardown 中の sandbox 合計が `SANDBOX_MAX_CONCURRENT` を超えない」（permit を detached cleanup 完了まで保持する不変条件）**）も検証
- [ ] **起動時 best-effort 孤児 sweep**: 所有プレフィクス（`exec-` / `prewarm-`）の persisted sandbox を起動時に列挙し best-effort で kill/removePersisted（クラッシュで create 後 removePersisted 前に落ちた場合の MSB_HOME ストレージ/リソース leak を bound。DB テーブルは持たず name プレフィクスのみで stateless に判定。Phase 0/A で「非 detached sandbox がプロセス/コンテナ終了で自動 GC されるか」を検証し、されるなら本 sweep は二重の安全弁、されないなら必須）
- [ ] 環境変数追加 + `envVars.ts` 反映
- [ ] unit test: sandboxService (microsandbox NAPI を mock 化)

### Phase B: 出力整形 + dev/test UI

- [ ] `codeExecutionService` 実装 (V2 components ビルダ + 出力 truncation + `File`/`MediaGallery` 振り分け + `allowedMentions: { parse: [] }`)。`formatToolBlock()` は **attachment-capable かつ mention-safe な payload `{ components, files, flags, allowedMentions }`**（`ToolRenderPayloadShape`）を返す（`/run` でも同 payload を `editReply` に流用）。**attachment 参照名は安全 allocator で採番**（生成 `exec-stdout.txt`/`exec-stderr.txt` と sandbox basename の衝突回避・sanitize・de-dup、`attachment://` と `files[].name` を一致、表示名は分離。上記「整形ルール詳細」10）。**可視 attachment 10 cap / message 40 component cap / 1 Container 子数上限の 3 つを単一メッセージで満たすレイアウト**（cap 近接時は File/MediaGallery を主 Container 外や同一メッセージ内の追加 top-level component / 追加 Container へ spill。`ToolRenderPayloadShape` は単一メッセージなので follow-up メッセージには分割せず、cap 超過分は drop + warning TextDisplay で省略表示）。**`/tmp/out/*` のファイル収集は sandboxService の責務（Phase A、sandbox 破棄前）であり、codeExecutionService は `ExecResult.files` を整形するだけ**（収集ロジックを再実装しない）
- [ ] `/config code-execution <on|off>` + `/config code-execution-network <on|off>` 2 サブコマンド
- [ ] `/run` スラッシュコマンド (**dev only registration** + **管理者限定**: `setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` + ハンドラ先頭で `member.permissions.has(Administrator)` 再確認して非管理者拒否〔guild toggle を意図的にバイパスするため二段確認〕、Modal 内 `Label`-wrap `StringSelect(language)` + `TextInput(code)` + `TextInput(timeout)`、**非 ephemeral defer**)
- [ ] ModalSubmitInteraction handler
- [ ] `/status` に sandbox 機能状態 (2 toggle) を表示

### Phase C: foundation への tool 登録（前提: tool-calling-foundation 実装済み）

- [ ] `src/llm/tools/codeExecution.ts` で `executeCodeTool` / `executeCodeWithNetworkTool` を `IClientTool` として実装（`isEnabled` の 2 toggle 分岐 + `SANDBOX_ENABLED`、`validate`、`timeoutMs`）
- [ ] `handler(args, ctx, signal, meta)` 実装: `sandboxService.execute({ ..., signal })` 呼出 + 正常完了時のみ `{ llmResult: JSON.stringify(toolResultForLlm(...)), render: formatToolBlock(...) }` を返す（`llmResult` は **文字列**。file bytes は LLM context から除外し render の Discord upload にのみ使う）
- [ ] **foundation `signal` abort 時のセマンティクス**: `signal.aborted`（foundation の request cancel / 180s per-tool wall timeout の双方）で `ExecHandle.kill()` → `sandbox.kill()` を発火し、cleanup 後に handler は正常結果を返さず generic な abort を throw する（**cancel/timeout の分類は foundation が signal 状態で行うので error 型は問わない**）。**args の `timeout_sec`（sandbox 内タイムアウト）は別物**で、これは reject せず `ExecResult.systemError.kind: "timeout"` を載せた正常な `ExecResult` を返し、`{ llmResult, render }` 経路に流す
- [ ] 2 tool を本 change から export し、合成ルート（`src/index.ts` DI）で foundation の `ToolRegistry.register()` に登録（foundation 所有ファイルは編集しない）
- [ ] **render payload passthrough の契約検証（Phase C の blocking precondition）**: 上流 `ToolRenderPayload` 型 + updater 実装が `ToolRenderPayloadShape`（components + files + flags + allowedMentions）を **attachment-capable + mention-safe に passthrough できる**ことを Phase C 着手前に確認。**満たす updater（temporary stub でも可、ただし `files`/`flags`/`allowedMentions` を運べること）が無い限り Phase C（LLM tool 経路）は着手しない** — foundation/chat-response-v2 が許す「legacy embed スタブ fallback」は**進捗テキスト（begin フック）専用で本 change の最終 render には不可**（Open Questions の `chat-response-v2` 依存項参照）。`handler.render` → foundation updater → Discord send/edit の経路で **(a) `files` の attachment upload が落ちないこと**と **(b) `allowedMentions: { parse: [] }` が適用されること**を検証する test を追加（updater は mock 可）。型が未対応なら上流 doc 側に反映依頼し、対応が入るまで Phase C を保留（本 change は上流所有ファイルを直接編集しない。`/run` 経路は updater 非依存なので先行可）
- [ ] foundation `IClientTool.timeoutMs` の dispatcher clamp 上限 C を読み、`actualToolTimeoutMs = min(180_000, C)`（tool の `timeoutMs` は 180_000 ハードコードなので C>180s でも実 wall は 180s 頭打ち）と `OVERHEAD_MS = QUEUE_WAIT_MS + SANDBOX_BOOT_DEADLINE_MS + SANDBOX_COLLECT_DEADLINE_MS + SANDBOX_TEARDOWN_DEADLINE_MS`（env 由来、既定 50_000）と `SAFETY_MARGIN_MS=10_000` から `effectiveTimeoutSecMax = floor((actualToolTimeoutMs − OVERHEAD_MS − SAFETY_MARGIN_MS) / 1000)` を導出（既定 env + `C ≥ 180s` なら 120）。`< 1` なら fail closed。さらに `defaultTimeoutSec = min(30, effectiveTimeoutSecMax)` を導出。この 2 値を schema `timeout_sec.maximum`/`default` / `validate` / `/run` modal / docs で共有（固定 120 / 30 をハードコードしない）
- [ ] `tools` / `tool_choice` 送出・streaming tool_call パース・`runToolLoop()` の `MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN`・「コード実行中...」progress フックは **foundation 側の Task**（本 change では実装しない）。本 change は `render` 断片の供給と `validate` / `isEnabled` の正しさだけを担保

### Phase D: 観測 + 仕上げ

- [ ] metrics: `sandbox_started_total` / `sandbox_failed_total` / `sandbox_active` / `sandbox_queue_wait_ms` / `code_exec_duration_ms`
- [ ] ログフィールド: guildId / channelId / userId / lang / code_hash / exit / duration / network / files_count / files_bytes
- [ ] integration test (`KVM_AVAILABLE=1` で実 sandbox 1 回起動 + timeout kill 確認 + allowedMentions stdout 確認)
- [ ] README の AUTO セクション再生成 (コマンド一覧 + 環境変数)
- [ ] docs/changes/code-execution/ 削除 (リリース完了時、git 履歴をアーカイブとする)

## Open Questions / Risks

- **LXC 内 `/dev/kvm` 配線が通らない可能性**: Phase 0 で判定。LXC config + Docker `--device` + コンテナ内 kvm group の **3 層プラミング**が必要で、特に Coolify が device pass-through を UI で許可していない場合は compose-override か raw Docker run の検討が必要。**所要時間は理想 30 分だが、3 層のどこかで詰まれば数時間規模に膨張する**ことを許容して見積もる。失敗時は迷わず Deploy-Plan B (別 Proxmox VM + HTTP wrapper) に pivot。
- **glibc 2.39 要件 / Bun NAPI 互換**: microsandbox は glibc ≥ 2.39 を要求する。`oven/bun:1-debian`（bookworm, glibc 2.36）では不足の可能性があり、Phase 0 で `ldd --version` 確認 → 不足なら Ubuntu 24.04 ベース等に切替。加えて Bun の NAPI 実装が microsandbox バインディングを完全サポートするかは未確証で、Phase 0 の `require("microsandbox")` smoke test で確認する。どちらかが通らなければ Deploy-Plan B（別 VM + HTTP wrapper、Bot からは HTTP 呼び出しで NAPI を回避）に pivot。
- **言語追加要求**: rust / go / ruby など。OCI image 追加だけで対応可能だが、`/run language` choices と tool schema の `language` enum も併せて更新が必要。enum を DB / 設定ファイル駆動にすべきかは v1 リリース後に判断。
- **`execute_code_with_network` の allow-list 維持コスト**: pypi mirror の host 変更等で壊れる可能性。環境変数で吸収する形にしているが、運用上 dashboard 化したくなる可能性あり。
- **モデル側の tool calling 安定性**: DeepSeek V4 Flash:free / Gemini Flash 系 / Claude Haiku 4.5 で問題が出たケースを観測したら、モデル選定 UI 側の絞り込み (別 spec) を優先する。protocol 整合の安定性そのものは foundation 側の懸念。
- **Components V2 message が sticky な点**: 一度 V2 として送信した message は legacy に戻せない。本機能の出力は最初から V2 で組むため問題にならない。
- **PATCH rate limit (chat 中の進捗更新)**: tool 実行中の「コード実行中...」表示で chat message を edit する経路は **foundation + `chat-response-v2`** の 2 秒 debounce + 429 スキップポリシーに乗る (本 spec で別途実装しない)。
- **`tool-calling-foundation` への依存**: 本 change の Phase C は foundation の `runToolLoop()` / `ToolRegistry` / `IClientTool` が前提。foundation 未完なら Phase 0/A/B（sandbox 基盤 + 出力整形 + `/run` dev UI）は先行できるが、LLM tool 経路（Phase C）は foundation 完了まで着手できない。逆に foundation 側は本 change を「最初の登録ツール」として参照する相互依存があるため、両者は同一バッチで起票・整合する。**3 つの契約要件を foundation/updater 側に surface する**: (1) `IClientTool.timeoutMs` の dispatcher clamp 上限が **≥ 180_000** であり、**かつその clamp 上限値 C を consumer が読めること**。foundation 設計は現状「`timeoutMs` を上下限で**クランプ**する」とだけ述べ clamp 上限の**名前付き定数も取得 API も定義していない**ので、本 change は foundation 側に **`CLIENT_TOOL_TIMEOUT_MAX_MS`（または同等の export/config 値）を定義・export すること**を依頼する（Phase C はそれを import して `actualToolTimeoutMs = min(180_000, C)` を計算する）。**この値が foundation から取得できない/未定義の場合の保守的フォールバック**: 本 change は C を foundation の**ドキュメント化された既定 clamp 上限**として扱い、それも不明なら `effectiveTimeoutSecMax` を導出できないため **fail-closed**（feature 無効化）にして、根拠のない 180s 想定で正規実行を wall timeout に倒すリスクを避ける。さもなくば本 change は実 clamp 値 C から effective `timeout_sec` 上限を `effectiveTimeoutSecMax = floor((actualToolTimeoutMs − OVERHEAD_MS − SAFETY_MARGIN_MS)/1000)`〔`actualToolTimeoutMs = min(180_000, C)`、= `actualToolTimeoutMs − 60s` 相当、OVERHEAD_MS は env デッドラインから算出〕に下げて budget 不変条件を維持。Decisions「wall timeout budget 不変条件」参照）、(2) `ToolRenderPayload` が **attachment-capable**（`components` + `files` + `flags` を運べる、正確な shape は Design「Discord 出力整形ルール」の `ToolRenderPayloadShape` 参照）であること（生成画像/ファイルの Discord upload に必須）、(3) **mention safety**: render 由来の send/edit に updater が `allowedMentions: { parse: [] }` を必ず適用すること（payload に載せて honor するか、updater が tool-block 描画時に常時 inject するか、いずれか。LLM tool 経路では実 send を行うのが updater であり、本 change は直接 `allowedMentions` を付けられないため）。**(2)(3) を満たさない狭い updater 型（components+flags のみ等）では本機能の binary 出力・mention 安全が崩れる**ので、Phase C で上流 doc 側の payload 型がこの shape を採用しているか確認し、未対応なら本 change の着手前に上流へ反映依頼する（本 change は上流所有ファイルを直接編集しない）。
- **`chat-response-v2` change との依存関係**: tool 進捗・最終応答 stream は foundation 経由で `chat-response-v2` の V2 streaming updater を利用する。`chat-response-v2` が未完でも foundation は updater をスタブ化して先行できるが、**本 change の `render` は attachment-capable + mention-safe（`ToolRenderPayloadShape`: components + files + flags + allowedMentions）を要求する**ため、**legacy text/embed のみの updater スタブでは不十分**（生成画像/ファイルを運べず `allowedMentions: { parse: [] }` も保証できない）。したがって Phase C（LLM tool 経路）の前提は「最低限 files/flags/allowedMentions を運べる updater（temporary stub でも可）」であり、純粋な legacy embed フォールバックには乗らない。**`chat-response-v2` 側で「updater スタブ + legacy 描画フォールバックで code-execution を先行可」と読める記述があれば、それは進捗テキスト（「コード実行中...」の begin フック）に限った話**で、本 change の**最終 tool render（`formatToolBlock()` の `ToolRenderPayloadShape`）には適用されない**点を両 doc 間で揃える（生成画像/ファイルの `files` upload・`attachment://` 参照・`IsComponentsV2`・`allowedMentions` を legacy text/embed は運べないため）。`/run` 経路は updater 非依存なのでこの制約を受けない（先行可能）。
- **`code_execution_network_enabled` の悪用リスク**: 二段階 toggle で対応するが、サーバ管理者が ON にした後の悪用 (LLM が悪意ある npm package をインストールする等) のリスクは構造的に残る。allow-list を厳しめに保つ + 監査ログ + 必要ならサーバ管理者向けに「最近実行された install コマンド」の表示機能を v1.1 で検討。
- **`_with_network` のデータ持ち出し境界（exfiltration）**: microVM は host 副作用を封じ込めるが、egress を許すと allow-list ホストや **DNS が prompt/コード由来データの exfil チャネル**になりうる（DNS tunneling 含む）。Phase A で network policy の DNS スコープ（任意ドメイン解決を許さない／resolver を絞れるか）を確認し、許せないなら残余リスクとして admin に明示する。allow-list は egress 宛先を絞るが「何を送るか」は止められない点を運用前提とする。
