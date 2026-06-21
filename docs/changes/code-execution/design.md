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

## Goals / Non-Goals

**Goals:**

- LLM tool として `execute_code({language, code})` を提供し、tool calling 対応モデルで自律的にコード実行・結果観察ができる
- デフォルト egress 禁止、ネットアクセス必要時は別 tool `execute_code_with_network` を明示的に呼ぶ設計。`with_network` 自体も guild 設定の **別 toggle** で明示有効化が必要（二段階ゲート）
- 言語 v1: `python` / `node` / `bash`。各々 OCI image (`python:3.13-slim` / `node:22-slim` / `debian:trixie-slim`)
- stdout / stderr / exitCode / 生成ファイル / 生成画像 を Discord Components V2 で整形して返す。長文 stdout は `File` 添付、ビットマップ画像 (PNG/JPEG) は `MediaGallery`、SVG / その他は `File`
- Guild 単位で機能の ON/OFF を切替可能（`code_execution_enabled` / `code_execution_network_enabled` 2 つのフラグ）
- 実装時のテスト用に `/run` スラッシュコマンドを `NODE_ENV !== "production"` 限定で提供（dev only、リリース時は未登録）
- LLM 出力 streaming は **tool_call delta を含め完全 streaming**。tool 実行中も「コード実行中...」進捗を表示し、tool 結果受領後は最終応答を delta stream

**Non-Goals:**

- **複数 exec 跨ぎでの変数・import・生成ファイル持続** — v1 は **1 tool call = 新規 sandbox 作成 → exec → 破棄** の per-call lifecycle。「会話文脈下での persistent sandbox」は既存の [`conversation-context`](../conversation-context/design.md) change で扱うので、本 spec では扱わない
- カスタム OCI image のユーザ指定 UI（v1 は固定 3 言語）
- pip / npm の永続パッケージ管理（毎回 fresh image、必要なら sandbox 内で `pip install` を含むコードを書いてもらう想定）
- GPU sandbox（microsandbox 自体が現状サポートしない）
- LLM tool call 時のユーザ事前承認ボタン（default-deny egress + per-guild 2 段階 toggle に依存）
- 永続ボリューム / 会話跨ぎのファイル共有
- `/run` の production 公開（dev only）
- 既存の `chat-response-v2` change（別途進行）との V2 builder 統合最適化 — 両者で V2 component を組むが、code-execution の output と chat-response の text stream は構造が大きく異なるため、共通 primitive は最小限（`buildErrorContainer` 等）に留め、それぞれ独立の builder を持つ

**将来別 change 候補:**

- モデル選定 UI の tool calling 絞り込み（`GET /api/v1/models?supported_parameters=tools` で `/model` choices を動的フィルタ）→ 別 change `model-selection-tool-filter`
- LLM チャット返信の Components V2 化 + 進捗表示インフラ → 既存 `chat-response-v2` で対応
- 設定 SSOT 化（envVars.ts を SSOT 化 + CLAUDE.md AUTO 生成）→ 別 change `default-model-ssot`
- Re-run button / Regenerate UI → 別 change（ephemeral in-memory store (TTL 短め) + per-user opt-in。コード本体保存がプライバシー方針と矛盾するため v1 不可）
- L2/L3 boost level に応じた `SANDBOX_FILE_MAX_BYTES` 自動上書き → v1.1
- 画像超過時の zip 化（bitmap > 10 枚 + その他多数）→ v1.1（v1 は個別 `File`）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| サンドボックス実装 | microsandbox | microVM ハードウェア隔離 + smoltcp ユーザ空間ネット (TUN 不要、LXC 親和性◯) + default-deny egress。Piston/Judge0 はホスト型で security profile が弱い |
| デプロイ形態 v1 | Bot コンテナ同居（Phase A） | 最短検証ルート。`/dev/kvm` を 3 層（Proxmox LXC → Docker → Bot コンテナ）でパススルー。失敗時は Phase B（別 VM + HTTP wrapper）に退避 |
| Bot ベースイメージ | `oven/bun:1-debian`（ただし glibc バージョン要確認） | microsandbox は **glibc 2.39 以上**を要求（`scripts/install.sh` の `LINUX_GLIBC_MIN_VERSION="2.39"`。Linux バンドルが Ubuntu 24.04/glibc 2.39 でビルドされるため）。Alpine/musl 不可。`oven/bun:1-debian` は Debian **bookworm**（glibc 2.36）ベースで **2.39 未満の可能性があり Phase 0 で要確認**。不足なら `ubuntu:24.04` + Bun 手動インストールのカスタム Dockerfile、または glibc 2.39+ を含む newer な debian/trixie タグへ切替 |
| イメージキャッシュ | コンテナ内の固定パス (`/data/microsandbox/`、`MSB_HOME` 環境変数で指定) を Docker named volume にマウント。Bot 起動時に 3 言語 image を **prewarm**: 各 image で `Sandbox.builder("prewarm-" + slugify(img)).image(img).create()` → `stopAndWait()` を 1 回ずつ実行することで image layer を pull + cache | 再起動毎の image pull を回避し、初回 tool call の応答時間を sandbox boot (~100ms) のみに。NAPI SDK には `Image.pull()` のような直接 API はない（`Image` クラスは get/list/inspect/remove/gc のみ）ので create-then-stop で代用。pull 完了を確実に検知したい場合は `Sandbox.builder(...).createWithPullProgress()`（レイヤ単位の進捗を返す）を使う選択肢もある。sandbox name は許容文字に制限がある可能性があるため `python:3.13-slim` のような image 名は `:` `/` を `-` に置換した slug を使う (例: `prewarm-python-3-13-slim`)。実 API の name 制約は Phase A の verify task で確認 |
| Sandbox name 採番 | per-call で `exec-${crypto.randomUUID()}` (collision-proof な短縮 ID) | microsandbox の Sandbox は name 必須、同時実行で衝突しないために UUID ベース |
| Sandbox ライフサイクル | **per tool call**: `Sandbox.builder(name).image(img).cpus(1).memory(512).create()` → `exec(cmd, args)` → 結果収集 (下記の fs read) → `stopAndWait()` を 1 リクエスト内で完結。permanent storage / detached なし | 「会話跨ぎで変数・import が持続」は **複数 exec 跨ぎで long-lived REPL kernel が必要** で v1 にはオーバーキル。[`conversation-context`](../conversation-context/design.md) change 側で per-conversation persistent sandbox を扱う |
| 結果として消える複雑性 | DB sandbox_sessions テーブル、TTL sweeper、LRU 強制停止、起動時孤児検出、channel-level privacy concern | 全て per-call lifecycle により構造的に不要 |
| 同時起動上限 | グローバル N 個（デフォルト 4）、超過時はキュー (Bottleneck や `p-limit` 等) で待機、待機 5 秒超で 503 相当をユーザに返却 | per-call lifecycle 下では「古い sandbox を kill」が無意味なので LRU ではなくキュー。同時 5 件以上の負荷は v1 では受けない |
| 1 turn あたり tool call 上限 | `MAX_TOOL_CALLS_PER_TURN = 3`、超過時は超過分の tool_call を「Too many tool calls in one turn」の error result で返し、LLM に再考を促す | モデルが 1 ターンで 50 個 tool call を emit する暴走パターン対策。グローバルキューと相まって sandbox flood を防ぐ |
| Tool call 実行順序 | 1 turn 内の複数 tool_call は **sequential** で実行 (`for ... await`) | parallel にすると Discord 出力順 / sandbox queue 順 / UI block ordering が複雑化。v1 は単純化 |
| 実行タイムアウト | デフォルト 30 秒、tool 引数で最大 120 秒まで上書き可。タイムアウト到達時はまず `ExecHandle.kill()` (in-VM プロセス送信) → 続けて `sandbox.kill()` (VM 全体強制終了) → `removePersisted()` でクリーンアップ | 無限ループ対策。`Sandbox.kill()` と `ExecHandle.kill()` は両方 NAPI SDK に存在 ([sdk/node-ts/src/sandbox.ts:336](https://github.com/superradcompany/microsandbox/blob/main/sdk/node-ts/src/sandbox.ts) / [exec.ts:127](https://github.com/superradcompany/microsandbox/blob/main/sdk/node-ts/src/exec.ts))。タイムアウトを race で実装し、両 kill 経路を順に試す |
| 同時実行ロック (sandbox 内) | per-call なので不要 (1 sandbox = 1 exec) | per-call lifecycle の副次的利点 |
| 出力上限 (host 側) | stdout/stderr 各 256 KB (`SANDBOX_OUTPUT_MAX_BYTES_HOST`)、超過は host 側 NAPI 受信時に truncate | sandbox 側の `head -c` ではなく NAPI レベル。Discord file attachment 上限 (`SANDBOX_FILE_MAX_BYTES`、9 MB) は別概念 (下記別行) |
| `/tmp/out/*` の収集上限 | 合計 50 MB / 最大 50 ファイル (host 側収集の上限)。**Discord に表示する個数は 10 まで** (bitmap MediaGallery 最大 8 + 個別 File 最大 2、Discord API の `files: [...]` 配列上限に合わせる)、超過は warning TextDisplay で「N 件のファイルが省略されました」を表示 | 暴走時の disk fill 防止 + Discord attachment 上限保護。詳細は「Discord 出力整形ルール」参照 |
| ネットワーク既定 | egress 完全禁止。`SandboxBuilder.disableNetwork()`（npm `microsandbox@0.5.4` では `network()` は callback 形式 `network((b)=>...)` で、旧設計の `.network({ enabled })` オブジェクト渡しは存在しない） | 最小権限。pypi 等が必要な場合は `execute_code_with_network` |
| `execute_code_with_network` の挙動 | default-deny + allow-list (`pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`, `objects.githubusercontent.com`)。RFC1918/loopback/cloud metadata は常時ブロック | TS SDK（npm `microsandbox@0.5.4`）の `.network((b) => ...)` callback で設定。**default-deny を基礎**にし、DNS と allow-list ドメインのみ許可する `{ rules: [Rule.allowDns(), Rule.allowEgress(Destination.domain("pypi.org")), Rule.allowEgress(Destination.domain("files.pythonhosted.org")), ...] }` を渡す（`NetworkPolicy.publicOnly()` は public 宛先**全般**を許可してしまい allow-list 用途には不適なので使わない）。`NetworkPolicy`（`none/allowAll/publicOnly/nonLocal` factory）/ `Destination` / `Rule` / `NetworkPolicyBuilder` / `RuleBuilder` は package から export 済み。allow-list は環境変数で拡張可。**network callback 内で policy を適用する正確な形のみ Phase A で実コード最終確認** |
| Network tool 有効化ゲート (二段階) | **`code_execution_network_enabled = false` がデフォルト**。`code_execution_enabled = true` でも `_with_network` tool は LLM に expose されない。両 toggle が true で初めて両 tool が tools 配列に入る | 「コード実行 OK」と「コード実行 + 外部ネット OK」を分離。npm/pip install は postinstall で任意コード実行できるため、サーバ管理者が **追加で意識的に許可**する必要 |
| Tool call の承認モデル | 両 tool とも自動実行 (UI 承認ボタンなし) | 二段階 toggle が承認ゲートの役割。実行中は per-call で UI 確認は UX を著しく悪化 |
| Tool 結果の LLM 渡し形式 | JSON 文字列で **stdout/stderr は先頭 4 KB + 末尾 4 KB のみ** (`SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES = 8192`, `SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES = 8192`)、超過時は `"\n...[truncated N bytes]...\n"` で繋ぐ。`exitCode` / `durationMs` / `truncated` / `files: [{name, size, mime}]` (file bytes は含めない) を付ける | host 側で受け取った 256 KB stdout をそのまま LLM context に流すと token 消費が暴騰 (例: 64K tokens = $0.06+)。Discord にはフル出力を attachment で渡しつつ、LLM には head+tail プレビューだけ渡す。`JSON.stringify` で `Uint8Array` が壊れる + バイナリを LLM context に流すのは無駄 |
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
| Streaming と tool calling の連携 | **完全 streaming**: OpenRouter の delta stream を parse、tool_call delta を蓄積、tool_call 完成時に tool 実行 (chat 上は「コード実行中...」 progress block 表示)、tool 結果を message に追加して次 turn 開始、最終応答も delta stream | `chat-response-v2` の V2 builder と連携。tool 呼出中は Container 内に 1 行 progress TextDisplay を edit で挿入、完了時に展開 (stdout / stderr / files) して chat 本文に続ける |
| Reasoning モデルでの tool calling | サポート対象として明示しない（warning なし） | DeepSeek V4 / GPT-5 / Claude Haiku 4.5 等は問題ないと判断。問題が出たらモデル選定 UI 側で対処 |
| PATCH rate limit (output メッセージ更新) | 完全 streaming で頻繁な edit が発生。chat-response-v2 と同じ 2 秒間隔の debounce を流用、429 受信時は edit スキップして次サイクル試行 | Discord channel-level PATCH rate limit (5/5s) との衝突回避 |

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
│  │  │  discord.js  ─┐                    │  │   │
│  │  │  chatService ─┼─► toolHandler ─┐   │  │   │
│  │  │  /run cmd    ─┘                │   │  │   │
│  │  │                                ▼   │  │   │
│  │  │            sandboxService          │  │   │
│  │  │              │ napi (microsandbox) │  │   │
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

- `src/services/sandboxService.ts` — per-call sandbox lifecycle (`execute()` のみ)、グローバル同時実行キュー、起動時 image pre-pull
- `src/services/codeExecutionService.ts` — Discord 整形ロジック (V2 Container 構築、`/tmp/out/*` ピックアップ、`allowedMentions: { parse: [] }` 強制、SVG/その他は `File` 振り分け、bitmap 画像は `MediaGallery`)
- `src/llm/tools/index.ts` — OpenRouter `Tool[]` 定義 (`execute_code` / `execute_code_with_network`)、tool exposure は guild の 2 toggle に応じて動的にフィルタ
- `src/llm/toolHandler.ts` — `tool_calls` を受けて `codeExecutionService` にディスパッチ、`role: 'tool'` メッセージを compact JSON で組み立てる (file bytes は含めない)
- `src/bot/commands/run.ts` — `/run` スラッシュコマンド + Modal handler (`NODE_ENV !== "production"` のみ登録)
- `tests/unit/services/sandboxService.test.ts`
- `tests/unit/services/codeExecutionService.test.ts`
- `tests/unit/llm/toolHandler.test.ts`
- `tests/integration/codeExecution.test.ts` — 実 sandbox を 1 回起動する smoke test (CI では skip、ローカル `KVM_AVAILABLE=1` で実行)

**修正:**

- `src/services/chatService.ts` — tool calling **完全 streaming ループ**: OpenRouter chat stream を読みつつ tool_call delta を蓄積、tool_call 完成時に toolHandler 呼出、結果を message 配列に push してストリームを継続、最大 5 turn
- `src/llm/openrouter.ts` — リクエストに `tools` / `tool_choice` を渡す経路 + streaming delta 内の tool_call 部分パース
- `src/db/schema.ts` — `guild_settings` に `code_execution_enabled INTEGER DEFAULT 0` + `code_execution_network_enabled INTEGER DEFAULT 0` 2 カラム追加。**`sandbox_sessions` テーブルは作らない**
- `src/db/repositories/guildSettingsRepository.ts` — 2 フラグの getter/setter
- `src/config/envVars.ts` — `SANDBOX_ENABLED` / `SANDBOX_MAX_CONCURRENT` / `SANDBOX_NETWORK_ALLOWLIST` / `SANDBOX_OUTPUT_MAX_BYTES_HOST` / `SANDBOX_OUT_FILES_MAX_BYTES` / `SANDBOX_OUT_FILES_MAX_COUNT` / `SANDBOX_FILE_MAX_BYTES` / `SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES` / `SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES` / `MSB_HOME` (TTL / idle 系は不要)
- `src/bot/commands/config.ts` — `/config code-execution <on|off>` + `/config code-execution-network <on|off>` 2 サブコマンド
- `src/bot/commands/index.ts` — `/run` を dev only 条件付き登録 (`if (process.env.NODE_ENV !== "production") commandDefinitions.push(runCommand)`)
- `src/bot/events/interactionCreate.ts`(or 該当 handler) — Modal submit ハンドラ。Re-run button は v1 では実装しない
- `package.json` — `microsandbox` 依存追加（最新 v0.5.4、Apache-2.0、活発にメンテ中）。`discord.js` は **v14.26.3 で `LabelBuilder`（modal 内 select / RadioGroup / Checkbox）対応済みのため bump 不要**（インストール済み 14.26.3）
- Dockerfile (image build 部分) — ベースは glibc ≥ 2.39 を満たすもの（`oven/bun:1-debian` が満たさなければ `ubuntu:24.04` + Bun 等）、`apt-get install -y --no-install-recommends ca-certificates` 程度
- docker-compose.yml / Coolify 設定 (runtime / orchestration 部分) — `devices: [/dev/kvm:/dev/kvm]` + `group_add: [kvm]` + volume `microsandbox_cache:/data/microsandbox`、entry script で `/dev/kvm` の存在を確認しない場合 fail-fast (`SANDBOX_ENABLED=true` のときのみ)

### DB スキーマ

```sql
ALTER TABLE guild_settings ADD COLUMN code_execution_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN code_execution_network_enabled INTEGER NOT NULL DEFAULT 0;
```

per-call lifecycle により sandbox 一覧テーブルは持たない (孤児検出も不要、sandbox は exec 終了時に必ず `stop()`)。

### LLM tool 定義

```ts
// src/llm/tools/index.ts
export const executeCodeTool: Tool = {
  type: "function",
  function: {
    name: "execute_code",
    description:
      "Execute code in an isolated microVM sandbox. Each call runs in a fresh sandbox; variables, imports, and generated files do NOT persist across calls. Network is disabled. Save generated images to /tmp/out/*.{png,jpg,jpeg,svg} to display them.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "node", "bash"] },
        code: { type: "string", description: "Source code to execute" },
        timeout_sec: { type: "integer", minimum: 1, maximum: 120, default: 30 },
      },
      required: ["language", "code"],
    },
  },
};

export const executeCodeWithNetworkTool: Tool = {
  type: "function",
  function: {
    name: "execute_code_with_network",
    description:
      "Same as execute_code but allows outbound network to a curated allow-list (PyPI, npm registry, GitHub object storage). Use only when package installation or external API is required. Each call is still in a fresh sandbox.",
    parameters: executeCodeTool.function.parameters,
  },
};

// guild の 2 toggle に応じて動的にフィルタ
export function buildToolsForGuild(settings: IGuildSettings): Tool[] {
  if (!settings.codeExecutionEnabled) return [];
  const tools = [executeCodeTool];
  if (settings.codeExecutionNetworkEnabled) tools.push(executeCodeWithNetworkTool);
  return tools;
}
```

`openrouter.ts` 側で `buildToolsForGuild()` の結果が空配列なら **`tools` も `tool_choice` も request body から omit する**。一部の OpenRouter 上流プロバイダは `tools: []` や空配列 + `tool_choice` の組み合わせを invalid として 400 を返すため。

### sandboxService の主要 API

```ts
interface ISandboxService {
  // 起動時に 3 言語 image を事前 prewarm (create → stopAndWait で layer cache を満たす)
  prewarmImages(): Promise<void>;

  // per-call lifecycle:
  //   1. let b = Sandbox.builder(`exec-${crypto.randomUUID()}`).image(img).cpus(1).memory(MiB(512));
  //      b = networkAllowed ? b.network((n) => n.policy(allowListPolicy)) : b.disableNetwork();
  //      const sandbox = await b.create();   // pull 完了を確実に待つなら createWithPullProgress() も可
  //   2. sandbox.exec("python", ["-c", code]) など (複数行 code は exec の args か shell(script)。Phase A で確定) を timeout で race
  //   3. /tmp/out から fs() 経由で生成ファイルを読み取り (詳細下記、list()/read())
  //   4. timeout 時は ExecHandle.kill() → sandbox.kill() の順、success 時は sandbox.stopAndWait()
  //   5. (再利用しないので必ず sandbox.removePersisted() で DB エントリも掃除)
  // 同時実行数が SANDBOX_MAX_CONCURRENT を超えると Bottleneck などのキューで待機、5 秒超で QueueTimeoutError を投げる
  execute(args: {
    language: "python" | "node" | "bash";
    code: string;
    timeoutSec: number;          // 1-120
    networkAllowed: boolean;     // true なら execute_code_with_network 相当
  }): Promise<ExecResult>;
}

interface ExecResult {
  stdout: string;                // host 側で 256 KB に truncate (full)
  stderr: string;                // host 側で 256 KB に truncate (full)
  exitCode: number;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
  // 生成ファイル (画像 + その他)。Discord upload の files: [] payload にそのまま渡す
  files: Array<{ name: string; bytes: Uint8Array; mime: string }>;
  // タイムアウトや OOM 等のシステム例外
  systemError?: { kind: "timeout" | "oom" | "boot_failed" | "queue_timeout"; message: string };
}
```

`/tmp/out/*` の取り出しは microsandbox の `sandbox.fs()` 経由 (**non-recursive**、サブディレクトリは無視):

```ts
const fs = sandbox.fs();
const entries = await fs.list("/tmp/out");          // SandboxFs.list()、サブディレクトリ entry は skip
for (const entry of entries) {
  if (entry.kind === "directory") continue;         // non-recursive (FsEntry.kind: "file"|"directory"|"symlink"|"other")
  if (totalBytes + entry.size > SANDBOX_OUT_FILES_MAX_BYTES) break;
  if (files.length >= SANDBOX_OUT_FILES_MAX_COUNT) break;
  const bytes = await fs.read(entry.path);          // SandboxFs.read() → Uint8Array
  const name = entry.path.split("/").at(-1) ?? entry.path;  // FsEntry に name は無く path のみ
  files.push({ name, bytes, mime: detectMime(name) });
  totalBytes += bytes.length;
}
```

非再帰仕様: ユーザ (LLM) には「画像やファイルは `/tmp/out/` 直下に保存してください」と tool description で誘導済 (executeCodeTool の description 内)。サブディレクトリ作成は機能上の non-goal。

(`sandbox.fs()` → `SandboxFs`（`microsandbox@0.5.4`）の API: `list(path)` → `FsEntry[]`（`{ path, kind, size, mode, modified }`、`readDir`/`isDirectory`/`name` は無い）、`read(path)` → `Uint8Array`、`readToString(path)` → string、`stat` / `exists` / `write` / `mkdir` / `remove` / `copyFromHost` / `copyToHost` 等。Phase A で allow-list 周りなど残りの細部を実コードで最終確認する)

注: tool 結果 (LLM に渡す `role: "tool"` content) は `ExecResult` 全体ではなく **head+tail clip された compact JSON**。詳細な実装は下記「tool calling 完全 streaming ループ」セクション内の `toolResultForLlm` 定義を参照。バイナリ bytes は LLM 文脈に流さず、Discord upload にだけ使う。Discord 側は 256 KB のフル出力 (truncate なしの場合) を `File` で受け取れる。

### Discord 出力整形ルール（Components V2）

メッセージは常に `MessageFlags.IsComponentsV2` flag を立てる。`content` / `embeds` フィールドは同時使用不可。**attachments は `files: [...]` payload upload としては引き続き送信可能** で、`File` / `MediaGallery` / `Thumbnail` component の中から `attachment://<filename>` で参照する形が公式パターン ([Discord File component](https://docs.discord.com/developers/components/reference))。一度 V2 として送信した message は legacy に edit-back できない (sticky flag)。

**全送信で `allowedMentions: { parse: [] }` を強制**。sandbox stdout に `@everyone` / `<@&roleId>` が含まれても発火しないようにする (TextDisplay は legacy embed.description と違いメッセージ本文と同じ ping 挙動)。

#### 構造テンプレート

```text
Container (accent color: green/yellow/red = success/truncated/error)
├ TextDisplay  "▶ python · 1.23s · exit 0"                ← ヘッダ行
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

#### 整形ルール詳細

1. **短文** (**ヘッダ + stdout + stderr + フッタの TextDisplay 合計が 1 message 4000 字制約に収まる**＝安全マージン込みで合計 ≤ 3800 字。fence ` ``` ` の overhead も計上。bitmap 画像 ≤ 4 枚): すべて `TextDisplay` + `MediaGallery` でインライン表示。stdout と stderr を両方インラインに載せる場合は両者で合計予算を共有し、超過分（大きい方優先で）を `File` に回す。
2. **長文 / truncate あり**: stdout/stderr を `File` (`stdout.txt`/`stderr.txt`) として attachment card 化、`TextDisplay` には先頭 N 行 + "... (attached output; truncated if host cap was hit)" を表示。host 側 256 KB cap (`SANDBOX_OUTPUT_MAX_BYTES_HOST`) を超えた場合は attachment 自体も truncate されていることを明示する文言を入れる。
3. **bitmap 画像 ≥ 5 枚**: `MediaGallery` (公式仕様で 1〜10 枚) に収めるが、**本 spec では下記の可視ファイル個数上限 (bitmap ≤ 8) を優先**。超過分は (a) `File` での代替添付か (b) warning TextDisplay の省略表示 に振り分ける。
4. **SVG / その他形式 (`.html`, `.csv`, `.json`, `.bin` 等)**: 全て `File` で添付。SVG は Discord client での inline 描画挙動が安定しないため `MediaGallery` には入れない。
5. **可視ファイル個数上限**: Discord API の `files: [...]` 配列の attachment 数は実用上 10 件/メッセージが上限 (`files` ≤ 10 が community で報告される common cap)。本 spec では **bitmap MediaGallery items ≤ 8 + 個別 File ≤ 2 = 計 10 attachment** を上限とする。超過分は warning TextDisplay 1 件で「N 件のファイルが省略されました (host 側収集は最大 50 まで、Discord 表示は 10 まで)」と表示し、優先順位は (a) bitmap 画像 → (b) `File` 系の順。これは V2 40-component 枠 (Container 1 + header / stdout / stderr / Separator / MediaGallery 1 + 個別 File 2 + warning + footer = ~10 components) にも収まる。**Phase A の実装着手時に Discord API の正確な attachment 上限を re-verify**、もし 5-7 等の小さい値だったら spec 側を絞る。
6. **例外** (タイムアウト / OOM / sandbox 起動失敗): Container accent を red、`TextDisplay` にエラー種別 + 原因。
7. **stdout/stderr の host 側上限**: 各 256 KB (`SANDBOX_OUTPUT_MAX_BYTES_HOST=262144`)、超過は NAPI 受信時に truncate。
8. **`/tmp/out/*` の host 側収集上限**: 合計 50 MB (`SANDBOX_OUT_FILES_MAX_BYTES`)、最大 50 ファイル (`SANDBOX_OUT_FILES_MAX_COUNT`)。超過分はリストから drop。
9. **個別ファイルの Discord upload 上限**: guild boost level に応じる (L0=10MB / L2=50MB / L3=100MB)。`SANDBOX_FILE_MAX_BYTES` (デフォルト 9 MB、L0 安全マージン) を超えるファイルは `File` ではなく warning TextDisplay に置換 ("file too large: N MB > limit M MB")。Bot 起動時に自 guild の boost level を取得して上書きするのは v1.1 で対応、v1 は固定値。

これら 4 種の上限値の役割は以下の通り:

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
     │   └ TextInputBuilder (paragraph, maxLength=4000)
     └ Label "Timeout sec (optional, max 120)"
         └ TextInputBuilder (short, required=false)
3. ユーザ submit
4. interactionCreate handler が ModalSubmitInteraction を捕捉
5. **`deferReply()` (非 ephemeral)** → sandboxService.execute() → Components V2 メッセージで editReply
```

Discord UI の制約と採用判断:

- **Modal in modal の select**: 2025-08-25 から `Label` で wrap すれば `StringSelect` 等を modal に入れられる（[Discord API change log](https://docs.discord.com/developers/change-log)）。discord.js では `LabelBuilder` を `modal.addLabelComponents(label)` で追加するのが推奨 API（旧 `addComponents(ActionRow)` パターンは legacy 扱い）。これにより slash option を削れて UX 簡潔。
- **RadioGroup の代替案**: 2026-02 から modal 内に `RadioGroup` / `Checkbox` が追加され、discord.js v14.26.x の `LabelBuilder.setRadioGroupComponent()` で利用可能。言語の 3 択（python/node/bash）は排他選択なので `StringSelect` より `RadioGroup` の方が意図が明確。v1 は `StringSelect` のままで可、UI 改善候補として記録。
- **Slash command string option (旧案)**: 1 行入力、改行は `\n` 手入力。modal に統合したので不要。
- **メッセージ添付 (.py / .js)**: 意図検知が暗黙的でコマンド誤反応リスク、却下。
- **コードブロックを含むメッセージ自動検知**: 同上、却下。
- **Private thread でのセッション隔離**: 検討したが v1 ではコマンド未公開のため不要。LLM tool call 経路はチャット文脈の中で結果を返すのが自然で thread 化のメリット薄。Phase 2 候補。
- **Defer の ephemeral**: `deferReply({ flags: MessageFlags.Ephemeral })` を使うと **以降の `editReply` も ephemeral 固定**で出力が消える (`followUp` で別途公開メッセージを送る必要がある)。dev/test 用途でも結果を残して回帰確認したいので、**`deferReply()` を非 ephemeral で打つ**。
- **`ephemeral: true` (legacy)**: discord.js v14.19 で deprecated、`flags: MessageFlags.Ephemeral` を使う。本 spec 内ではどこにも ephemeral を使わない。

### tool calling 完全 streaming ループ

`chatService` の擬似コード (簡略化、エラーハンドリング省略):

```ts
let messages = [...history, userMessage];
for (let turn = 0; turn < MAX_TURNS; turn++) {
  // OpenRouter chat completions の SSE stream を読む
  const stream = openrouter.chatStream({ model, messages, tools });

  // delta 蓄積バッファ
  let accumContent = "";
  const accumToolCalls = new Map<number, { id: string; name: string; args: string }>();

  for await (const event of stream) {
    const delta = event.choices[0].delta;
    if (delta.content) {
      accumContent += delta.content;
      // chat-response-v2 の TextDisplay edit を debounce で発火 (2 秒間隔)
      chatResponseUpdater.appendStreamingText(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const slot = accumToolCalls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        accumToolCalls.set(tc.index, slot);
      }
    }
  }

  // tool_call の validation を **assistant message push 前に** 実施。
  // OpenAI/OpenRouter プロトコルでは「assistant の tool_call の id」と「対応する
  // role:"tool" メッセージの tool_call_id」が 1:1 一致する必要があり、id が空のまま
  // assistant message を push したあとに synthetic id で tool 結果を返すと不整合になる。
  // 対策: id が欠落している tool_call は assistant message に乗せる際に **その場で
  // synthetic id を採番して埋める**、その同じ id で tool 結果を返す。
  const rawCalls = Array.from(accumToolCalls.values());
  // 段階 1: function.name が完全に欠落しているものは assistant message からも除外
  //   (空 name で OpenRouter / 上流 OpenAI が history validation で reject する可能性があり、
  //    対応する tool result を返す手段もない。warn ログ + 履歴から落とす)。
  const namedCalls = rawCalls.filter(tc => {
    if (!tc.name) {
      logger.warn("tool_call dropped: missing function.name", { index: tc.index, partial_id: tc.id });
      return false;
    }
    return true;
  });

  // 段階 2: name はあるが他の問題があるものは synthetic id + error result で処理
  //   (assistant message には正規の tool_call として乗せ、id 一致の error role:tool を返す)
  const normalizedCalls = namedCalls.map(tc => {
    const id = tc.id || `synthetic-${crypto.randomUUID()}`;  // 一度ここで採番
    if (!tc.id) return { id, name: tc.name, args: tc.args, _err: "missing tool_call_id from stream delta" };
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(tc.args || "{}");
    } catch (e) {
      return { id, name: tc.name, args: tc.args, _err: `invalid JSON arguments: ${(e as Error).message}` };
    }
    if (tc.name !== "execute_code" && tc.name !== "execute_code_with_network") {
      return { id, name: tc.name, args: tc.args, _err: `unknown tool name: ${tc.name}` };
    }
    return { id, name: tc.name, args: tc.args, parsed: parsedArgs as ToolArgs };
  });

  // 1 turn あたり tool call 数の上限チェック (assistant message にも反映するため早めに分岐)
  const overflow = normalizedCalls.slice(MAX_TOOL_CALLS_PER_TURN).map(tc => ({
    ...tc,
    _err: `Exceeded MAX_TOOL_CALLS_PER_TURN=${MAX_TOOL_CALLS_PER_TURN}; not executed.`,
  }));
  const inWindow = normalizedCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
  const allCalls = [...inWindow, ...overflow];

  // assistant message を履歴に push (採番済み id を使用)
  messages.push({
    role: "assistant",
    content: accumContent || null,
    tool_calls: allCalls.length === 0 ? undefined : allCalls.map(tc => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.args },
    })),
  });

  if (allCalls.length === 0) return; // 通常の最終応答、stream 完了

  // overflow + _err 持ちには error tool result を返す (同じ採番 id を使うので整合)
  for (const tc of allCalls.filter(t => "_err" in t)) {
    messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify({ error: tc._err }),
    });
  }
  const validCalls = inWindow.filter(t => !("_err" in t));

  // tool 実行 (v1 は sequential、UI には "コード実行中..." progress block 表示)
  for (const tc of validCalls) {
    chatResponseUpdater.beginToolBlock(tc.name);  // V2 Container に「コード実行中」TextDisplay 挿入
    const result = await toolHandler.dispatch(tc, ctx);
    chatResponseUpdater.endToolBlock(tc.name, result);  // V2 Container を exec 結果で展開
    messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify(toolResultForLlm(result)),  // head+tail truncated, file bytes 除外 (上述参照)
    });
  }
  // 次 turn 開始 (次の stream で LLM が結果を踏まえて応答)
}
throw new MaxToolTurnsExceededError();
```

`MAX_TURNS = 5` (assistant turn 数上限) と `MAX_TOOL_CALLS_PER_TURN = 3` (1 turn の tool call 個数上限) の 2 軸で暴走防止。`ctx` は `{ channelId, guildId, userId }`。`chatResponseUpdater` は `chat-response-v2` change で提供される V2 message ストリーミング更新インタフェース。tool block の Container 表示は本 spec の `codeExecutionService.formatToolBlock(result)` で行う。

`toolResultForLlm()` 定義 (LLM context 圧迫対策で head+tail clip):

```ts
function toolResultForLlm(r: ExecResult) {
  return {
    stdout: clipHeadTailBytes(r.stdout, SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES),  // 8 KB head+tail
    stderr: clipHeadTailBytes(r.stderr, SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES),  // 8 KB
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    truncated: r.truncated,
    files: r.files.map(f => ({ name: f.name, size: f.bytes.length, mime: f.mime })),
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
  const half = Math.floor(cap / 2);
  const head = sliceFromHeadByBytes(s, half);
  const tail = sliceFromTailByBytes(s, half);
  return head + `\n...[truncated ${totalBytes - cap} bytes]...\n` + tail;
}
// sliceFromHeadByBytes / sliceFromTailByBytes は文字境界を尊重して切る (実装は省略)
```

### 環境変数

| 名前 | デフォルト | 用途 |
| ---- | ---------- | ---- |
| `SANDBOX_ENABLED` | `false` | 機能全体の kill switch (false なら DB toggle に関わらず tools 配列に追加しない) |
| `SANDBOX_MAX_CONCURRENT` | `4` | 同時 sandbox 起動上限 (キュー入り、5 秒超で 503 相当) |
| `SANDBOX_DEFAULT_CPUS` | `1` | per-sandbox CPU |
| `SANDBOX_DEFAULT_MEMORY_MIB` | `512` | per-sandbox RAM |
| `SANDBOX_NETWORK_ALLOWLIST` | `pypi.org,files.pythonhosted.org,registry.npmjs.org,objects.githubusercontent.com` | `_with_network` ツール経路で許可される egress ホスト |
| `SANDBOX_OUTPUT_MAX_BYTES_HOST` | `262144` (256 KB) | host NAPI で受け取る stdout/stderr の truncate 閾値 |
| `SANDBOX_OUT_FILES_MAX_BYTES` | `52428800` (50 MB) | `/tmp/out/*` の合計サイズ、超過分は drop |
| `SANDBOX_OUT_FILES_MAX_COUNT` | `50` | `/tmp/out/*` のファイル個数 (Discord 表示は別途 10 cap、bitmap MediaGallery 8 + File 2) |
| `SANDBOX_FILE_MAX_BYTES` | `9437184` (9 MB) | Discord upload する個別ファイルの上限 (L0 安全マージン) |
| `SANDBOX_TOOL_RESULT_STDOUT_MAX_BYTES` | `8192` (8 KB) | LLM への tool result で stdout を head+tail で clip する上限 |
| `SANDBOX_TOOL_RESULT_STDERR_MAX_BYTES` | `8192` (8 KB) | 同 stderr 用 |
| `MSB_HOME` | `/data/microsandbox` (コンテナ絶対パス) | NAPI が参照する microsandbox ホームディレクトリ。Docker named volume をここにマウント |

### セキュリティ・観測

- 既存の `metrics.ts`（admin-endpoints で導入予定）に `sandbox_started_total` / `sandbox_failed_total` / `sandbox_active` / `sandbox_queue_wait_ms` / `code_exec_duration_ms` を追加。
- ログ: 実行 1 件ごとに `{ guildId, channelId, userId, lang, code_hash, exit, duration_ms, network, files_count, files_bytes }` を info で出力。コード本体は **ログしない** (プライバシー + token 削減)。
- `code_execution_enabled = 0` の guild は `buildToolsForGuild()` が空配列を返し、`openrouter.ts` 側で **`tools` も `tool_choice` も request body から omit して** OpenRouter に送信 (一部上流プロバイダは `tools: []` + `tool_choice` の組み合わせを invalid と判定)。LLM 側に tool が見えないので「無効化されています」を作文させる必要なし。
- `code_execution_enabled = 1, code_execution_network_enabled = 0` の場合は `execute_code` のみ expose、`execute_code_with_network` は配列に入れない。
- `SANDBOX_ENABLED = false` の場合は guild 設定に関わらず両 tool を expose しない (同じく `tools` 自体を omit)。
- mention safety: 全 V2 送信 (`channel.send` / `message.edit` / `interaction.editReply` / `interaction.followUp` / `message.reply` 全て) で `allowedMentions: { parse: [] }`。`message.reply()` 経路を使う場合は **追加で `allowedMentions.repliedUser: false`** を併用 (上書きでない限り元投稿者を ping するため)。コードや stdout に書かれた mention 構文 (`<@!1234>` 等) は表示はされるが ping は発火しない。

### 参照

- microsandbox README & docs: <https://github.com/superradcompany/microsandbox>
  - `sdk/node-ts/README.md` — NAPI SDK 概要、detached mode
  - `docs/networking/security-model.mdx` — default-deny egress 仕様
  - `docs/configuration.mdx` — `sandbox_defaults` / paths
  - `scripts/install.sh` — glibc ≥ 2.39 要件（`LINUX_GLIBC_MIN_VERSION="2.39"`）、musl 拒否
- OpenRouter tool calling: <https://openrouter.ai/docs/guides/features/tool-calling>
- OpenRouter models filter: `GET /api/v1/models?supported_parameters=tools`
- discord.js Modal: <https://discordjs.guide/interactions/modals.html>
- Discord Components V2 (2025-04-22 リリース): <https://docs.discord.com/developers/components/reference>
- discord.js PR #10781 (Components V2 in v14): <https://github.com/discordjs/discord.js/pull/10781>
- discord.js `LabelBuilder`（modal 内 select / RadioGroup / Checkbox、v14.25.1+ / 14.26.3）: <https://discord.js.org/docs/packages/discord.js/14.26.3/LabelBuilder:Class>
- Discord Developer Change Log: <https://docs.discord.com/developers/change-log>

## Tasks

### Phase 0: ホスト検証（実装着手の前提条件）

- [ ] Proxmox LXC conf に `/dev/kvm` パススルー + `nesting=1` 設定
- [ ] Coolify Bot コンテナのベースを決定し起動確認。**先に `ldd --version` で glibc ≥ 2.39 を確認**（`oven/bun:1-debian`=bookworm は 2.36 で不足の可能性。不足なら `ubuntu:24.04` ベース等に切替）
- [ ] Bot コンテナ内で `ls -l /dev/kvm` と `npx microsandbox run debian -- echo hi` が成功することを確認
- [ ] **Bun ランタイムで `require("microsandbox")` が NAPI エラーなくロードできることを smoke test**（Bun の NAPI 実装が microsandbox バインディングと互換か）
- [ ] 失敗時の判定: Phase A 中止 → Phase B（別 Proxmox VM + HTTP wrapper）に切替方針を再起票

### Phase A: sandbox 基盤

- [ ] `microsandbox` 依存追加（v0.5.4）。`discord.js` は 14.26.3 で `LabelBuilder` 対応済みのため bump 不要
- [ ] `/data/microsandbox` を named volume 化 (Coolify / docker-compose 設定)
- [ ] DB マイグレーション: `code_execution_enabled` + `code_execution_network_enabled` 2 カラム追加
- [ ] microsandbox SDK の network 設定（`disableNetwork()` / `network((b)=>...)` callback 内で **default-deny + `Rule.allowDns()` + allow-list ドメインの `Rule.allowEgress(Destination.domain(...))`** を適用する形）を実コードで最終確認（API 名は `microsandbox@0.5.4` の型のとおり。callback 内の policy 適用形のみ未確定）
- [ ] microsandbox SDK の `sandbox.fs()` → `SandboxFs.list()` / `read()` / `readToString()` と `FsEntry { path, kind, size, mode, modified }` の実挙動を実装時に最終確認
- [ ] `sandboxService` 実装 (`prewarmImages` (create-stopAndWait) + `execute` (UUID name 採番、Bottleneck で同時数キュー、5 秒超で QueueTimeoutError))
- [ ] Bot 起動時に 3 言語 image を prewarm (`SANDBOX_ENABLED=true` 時のみ)
- [ ] timeout → `ExecHandle.kill()` → `sandbox.kill()` → `removePersisted()` パスの統合動作確認
- [ ] 環境変数追加 + `envVars.ts` 反映
- [ ] unit test: sandboxService (microsandbox NAPI を mock 化)

### Phase B: 出力整形 + dev/test UI

- [ ] `codeExecutionService` 実装 (V2 Container ビルダ + 出力 truncation + `/tmp/out/*` ピックアップ + `File`/`MediaGallery` 振り分け + `allowedMentions: { parse: [] }`)
- [ ] `/config code-execution <on|off>` + `/config code-execution-network <on|off>` 2 サブコマンド
- [ ] `/run` スラッシュコマンド (**dev only registration**、Modal 内 `Label`-wrap `StringSelect(language)` + `TextInput(code)` + `TextInput(timeout)`、**非 ephemeral defer**)
- [ ] ModalSubmitInteraction handler
- [ ] `/status` に sandbox 機能状態 (2 toggle) を表示

### Phase C: LLM tool 統合 (完全 streaming)

- [ ] `src/llm/tools/index.ts` で 2 tool 定義 + `buildToolsForGuild(settings)` で動的フィルタ
- [ ] `openrouter.ts` で `tools` / `tool_choice` を送出 + streaming delta 内の `tool_calls` 部分パース
- [ ] `toolHandler.dispatch` 実装 (compact JSON 化、file bytes は LLM context から除外)
- [ ] `chatService` の完全 streaming ループ (MAX_TURNS=5、tool block 中も「コード実行中...」を chat-response-v2 経由で進捗表示)
- [ ] tool 結果メッセージのフォーマット (上述 `toolResultForLlm`)

### Phase D: 観測 + 仕上げ

- [ ] metrics: `sandbox_started_total` / `sandbox_failed_total` / `sandbox_active` / `sandbox_queue_wait_ms` / `code_exec_duration_ms`
- [ ] ログフィールド: guildId / channelId / userId / lang / code_hash / exit / duration / network / files_count / files_bytes
- [ ] integration test (`KVM_AVAILABLE=1` で実 sandbox 1 回起動 + timeout kill 確認 + allowedMentions stdout 確認)
- [ ] README の AUTO セクション再生成 (コマンド一覧 + 環境変数)
- [ ] docs/changes/code-execution/ 削除 (リリース完了時、git 履歴をアーカイブとする)

## Open Questions / Risks

- **LXC 内 `/dev/kvm` 配線が通らない可能性**: Phase 0 で判定。LXC config + Docker `--device` + コンテナ内 kvm group の **3 層プラミング**が必要で、特に Coolify が device pass-through を UI で許可していない場合は compose-override か raw Docker run の検討が必要。**所要時間は理想 30 分だが、3 層のどこかで詰まれば数時間規模に膨張する**ことを許容して見積もる。失敗時は迷わず Phase B (別 Proxmox VM + HTTP wrapper) に pivot。
- **glibc 2.39 要件 / Bun NAPI 互換**: microsandbox は glibc ≥ 2.39 を要求する。`oven/bun:1-debian`（bookworm, glibc 2.36）では不足の可能性があり、Phase 0 で `ldd --version` 確認 → 不足なら Ubuntu 24.04 ベース等に切替。加えて Bun の NAPI 実装が microsandbox バインディングを完全サポートするかは未確証で、Phase 0 の `require("microsandbox")` smoke test で確認する。どちらかが通らなければ Phase B（別 VM + HTTP wrapper、Bot からは HTTP 呼び出しで NAPI を回避）に pivot。
- **言語追加要求**: rust / go / ruby など。OCI image 追加だけで対応可能だが、`/run language` choices と tool schema の `language` enum も併せて更新が必要。enum を DB / 設定ファイル駆動にすべきかは v1 リリース後に判断。
- **`execute_code_with_network` の allow-list 維持コスト**: pypi mirror の host 変更等で壊れる可能性。環境変数で吸収する形にしているが、運用上 dashboard 化したくなる可能性あり。
- **モデル側の tool calling 安定性**: DeepSeek V4 Flash:free / Gemini Flash 系 / Claude Haiku 4.5 で問題が出たケースを観測したら、モデル選定 UI 側の絞り込み (別 spec) を優先する。
- **Components V2 message が sticky な点**: 一度 V2 として送信した message は legacy に戻せない。本機能の出力は最初から V2 で組むため問題にならない。
- **PATCH rate limit (chat 中の進捗更新)**: tool 実行中の「コード実行中...」表示で chat message を edit する経路は `chat-response-v2` の 2 秒 debounce + 429 スキップポリシーをそのまま流用 (本 spec で別途実装しない)。
- **`chat-response-v2` change との依存関係**: 本 spec の Phase C (LLM tool 統合) は `chat-response-v2` の V2 streaming updater を利用する。`chat-response-v2` が完了していない時期に Phase C を着手する場合、進捗 TextDisplay の updater をスタブで置いて legacy embed 描画にフォールバックする必要あり (実装時に判断)。
- **`code_execution_network_enabled` の悪用リスク**: 二段階 toggle で対応するが、サーバ管理者が ON にした後の悪用 (LLM が悪意ある npm package をインストールする等) のリスクは構造的に残る。allow-list を厳しめに保つ + 監査ログ + 必要ならサーバ管理者向けに「最近実行された install コマンド」の表示機能を v1.1 で検討。
