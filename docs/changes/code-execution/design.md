# コード実行（microsandbox 統合）

## Why

LLM はコードを書けるが実行できないため、計算結果の検証・データ可視化・ライブラリ挙動の確認といった「書いて動かして観察する」フローを Bot 内で完結できない。ユーザは別環境にコピペして実行する手間を強いられ、対話の流れが切れる。

[microsandbox](https://github.com/superradcompany/microsandbox) を使い、LLM の tool call と `/run` スラッシュコマンドの両方から microVM 上でコードを実行できるようにする。microVM によるハードウェア隔離と smoltcp ベースの default-deny egress により、ホスト側に追加のセキュリティ機構を実装せずに untrusted コード実行を許容できる。

## Goals / Non-Goals

**Goals:**

- LLM tool として `execute_code({language, code})` を提供し、tool calling 対応モデルで自律的にコード実行・結果観察ができる
- ユーザ起点の `/run` スラッシュコマンド（Discord Modal でコード入力）でも同じ実行パスを利用できる
- 会話セッション単位（チャンネル ID）で sandbox を detached で保持し、変数・import・生成ファイルが連続実行で引き継がれる
- デフォルト egress 禁止、ネットアクセス必要時は別 tool `execute_code_with_network` を明示的に呼ぶ設計
- 言語 v1: `python` / `node` / `bash`。各々 OCI image (`python:3.13-slim` / `node:22-slim` / `debian:trixie-slim`)
- stdout/stderr/exit code/生成ファイルを Discord に整形して返す。長文は自動で添付ファイル化、画像 (PNG/JPEG/SVG) は埋め込み表示
- Guild 単位で機能の ON/OFF を切替可能（デフォルト OFF、追加リソース消費があるため明示有効化）

**Non-Goals:**

- モデル選定 UI の tool calling 対応モデル絞り込み（別 change: `model-selection-tool-filter` を切る）
- カスタム OCI image のユーザ指定 UI（v1 は固定 3 言語）
- pip / npm の永続パッケージ管理（毎回 fresh image、必要なら sandbox 内で `pip install` を含むコードを書いてもらう想定）
- GPU sandbox（microsandbox 自体が現状サポートしない）
- マルチユーザ DM での sandbox 隔離（v1 はチャンネル粒度のみ。DM 利用は warning 表示）
- LLM tool call 時のユーザ事前承認ボタン（default-deny egress に依存。`with_network` 版のみ将来的に検討）
- 永続ボリューム / 会話跨ぎのファイル共有

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| サンドボックス実装 | microsandbox | microVM ハードウェア隔離 + smoltcp ユーザ空間ネット (TUN 不要、LXC 親和性◯) + default-deny egress + detached session 機構が用途と一致。Piston/Judge0 はホスト型で会話セッション持続が難しい |
| デプロイ形態 v1 | Bot コンテナ同居（Phase A） | 最短検証ルート。`/dev/kvm` を 3 層（Proxmox LXC → Docker → Bot コンテナ）でパススルー。失敗時は Phase B（別 VM + HTTP wrapper）に退避 |
| Bot ベースイメージ | `oven/bun:debian` | microsandbox は glibc 必須（`scripts/install.sh:379-390`）。Alpine 系不可 |
| イメージキャッシュ | `~/.microsandbox/` を Docker named volume にマウント | 再起動毎の image pull を回避 |
| Sandbox 生存粒度 | Discord チャンネル ID = sandbox name | スレッド/フォーラム投稿も `channelId` で一意。DM は `dm-${userId}` |
| Sandbox ライフサイクル | `createDetached()` + アイドル N 分で sweeper が `stop()` | 連続実行で state 保持しつつリーク防止 |
| アイドル TTL | 10 分（環境変数で上書き可） | Discord の会話間隔の中央値想定。長く取りすぎるとメモリ食う |
| 同時起動上限 | グローバル N 個（デフォルト 4）、超過時は LRU で古い sandbox を強制停止 | ホスト RAM 保護。`env: SANDBOX_MAX_CONCURRENT` |
| ネットワーク既定 | egress 完全禁止（`network.enabled = false`） | 最小権限。pypi 等が必要な場合は `execute_code_with_network` |
| `execute_code_with_network` の挙動 | default-deny + allow-list（`pypi.org`, `registry.npmjs.org`, etc.）。RFC1918/loopback/cloud metadata は smoltcp 側で常時ブロック | microsandbox の `NetworkPolicy` を使う。allow-list は環境変数で拡張可 |
| Tool call の承認モデル | `execute_code` は自動実行、`execute_code_with_network` も自動実行（allow-list 内なので） | UI 承認ボタンを挟むと Bot のラウンドトリップが増え UX 悪化。隔離と allow-list で blast radius 抑止 |
| 実行タイムアウト | デフォルト 30 秒、tool 引数で最大 120 秒まで上書き可 | 無限ループ・暴走対策。Discord interaction の defer 制限（15 分）の遥か内側 |
| 出力上限 | stdout/stderr 各 256 KB、超過は truncate + 切り捨て表示 | sandbox 側で `head -c` ではなくホスト側 NAPI 受信時に切る |
| Discord 出力整形 | 1500 字以下 + 単一ブロック: 本文埋め込み。それ以上: stdout/stderr/exit/files を Embed + `output.txt` 添付。PNG/JPEG/SVG は image embed | Discord 2000 字制限と添付ファイル UI を活用 |
| 画像出力ピックアップ | sandbox 終了後 `/tmp/out/*.{png,jpg,jpeg,svg}` を自動収集 | matplotlib / Pillow 等の慣習的な出力場所を強制せず、ユーザに「`/tmp/out/` に保存して」と暗黙ルールを置く |
| ユーザ UI | `/run language:<select> code:<modal>` | Modal の paragraph text input は 4000 字まで対応。slash option の string は 1 行で改行扱いが面倒 |
| 言語選択 | スラッシュ choices で `python` / `node` / `bash` 固定 | v1 は限定。将来 image 拡張時に choices 更新 |
| DB スキーマ | `sandbox_sessions` テーブル + `guild_settings.code_execution_enabled` | 起動時の孤児 sandbox 検出 + ON/OFF |
| 孤児検出 | Bot 起動時に `Sandbox.list()` と DB を突合、片側にしかないものは `stop()` + DB から削除 | プロセスクラッシュ後のリーク回収 |
| Reasoning モデルでの tool calling | サポート対象として明示しない（warning なし） | DeepSeek V4 / GPT-5 / Claude Haiku 4.5 等は問題ないと判断。問題が出たらモデル選定 UI 側で対処 |

## Design

### アーキテクチャ

```text
┌─────────────────────────────────────────────────┐
│ Proxmox LXC (unprivileged, nesting=1)           │
│  /dev/kvm → bind                                │
│  ┌──────────────────────────────────────────┐   │
│  │ Docker (Coolify)                         │   │
│  │  ┌────────────────────────────────────┐  │   │
│  │  │ Bot Container (oven/bun:debian)    │  │   │
│  │  │  --device /dev/kvm                 │  │   │
│  │  │  group_add: kvm                    │  │   │
│  │  │  vol: ~/.microsandbox              │  │   │
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
│  │  │      ┌──────────────┐              │  │   │
│  │  │      │ microVM #N   │ (per channel)│  │   │
│  │  │      │ agentd inside│              │  │   │
│  │  │      └──────────────┘              │  │   │
│  │  └────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 変更対象

**新規ファイル:**

- `src/services/sandboxService.ts` — detached sandbox lifecycle (`getOrCreate`, `execute`, `stop`, `cleanup`)、LRU TTL sweeper、起動時孤児検出
- `src/services/codeExecutionService.ts` — Discord 整形ロジック（出力 truncation、画像ピックアップ、添付ファイル化）
- `src/llm/tools/index.ts` — OpenRouter `Tool[]` 定義（`execute_code` / `execute_code_with_network`）
- `src/llm/toolHandler.ts` — `tool_calls` を受けて `codeExecutionService` にディスパッチ、`role: 'tool'` メッセージを組み立てる
- `src/bot/commands/run.ts` — `/run` スラッシュコマンド + Modal handler
- `tests/unit/services/sandboxService.test.ts`
- `tests/unit/services/codeExecutionService.test.ts`
- `tests/unit/llm/toolHandler.test.ts`
- `tests/integration/codeExecution.test.ts` — 実 sandbox を 1 回起動する smoke test（CI では skip、ローカル `KVM_AVAILABLE=1` で実行）

**修正対象:**

- `src/services/chatService.ts` — tool calling 多ターンループ（`tool_calls` を検知して toolHandler を呼び、結果を会話に追加して再 LLM 呼び出し、最大 5 turn）
- `src/llm/openrouter.ts` — リクエストに `tools` / `tool_choice` を渡す経路を追加
- `src/db/schema.ts` — `sandbox_sessions` テーブル + `guild_settings.code_execution_enabled`
- `src/db/repositories/` — `sandboxSessionRepository.ts` 追加、`guildSettingsRepository.ts` 拡張
- `src/config/envVars.ts` — `SANDBOX_ENABLED` / `SANDBOX_MAX_CONCURRENT` / `SANDBOX_IDLE_TTL_SEC` / `SANDBOX_NETWORK_ALLOWLIST` / `MSB_HOME`
- `src/bot/commands/config.ts` — `/config code-execution <on|off>` サブコマンド
- `src/bot/commands/index.ts` — `/run` 登録
- `src/bot/events/interactionCreate.ts`（または該当 handler） — Modal submit ハンドラ追加
- `package.json` — `microsandbox` 依存追加
- Dockerfile — ベース変更 `oven/bun:1-debian`、kvm group 設定

### DB スキーマ

```sql
ALTER TABLE guild_settings ADD COLUMN code_execution_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sandbox_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL UNIQUE,
  sandbox_name TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL,
  last_used_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sandbox_sessions_last_used ON sandbox_sessions(last_used_at);
```

`sandbox_name` は `ch-${channelId}` または `dm-${userId}`。

### LLM tool 定義

```ts
// src/llm/tools/index.ts
export const codeExecutionTools: Tool[] = [
  {
    type: "function",
    function: {
      name: "execute_code",
      description:
        "Execute code in an isolated microVM sandbox. State (variables, imports, files) persists across calls within the same conversation. Network is disabled.",
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
  },
  {
    type: "function",
    function: {
      name: "execute_code_with_network",
      description:
        "Same as execute_code but allows outbound network to a curated allow-list (PyPI, npm registry, etc.). Use only when package installation or external API is required.",
      parameters: { /* 同上 */ },
    },
  },
];
```

### sandboxService の主要 API

```ts
interface ISandboxService {
  // detached sandbox を取得 (なければ作成)。last_used_at を更新
  getOrCreate(channelId: string, image: string): Promise<Sandbox>;
  // 実行 (timeout 適用、stdout/stderr/exit/files を返す)
  execute(channelId: string, code: string, lang: Language, timeoutSec: number): Promise<ExecResult>;
  // 明示停止
  stop(channelId: string): Promise<void>;
  // sweeper (cron で 5 分毎)
  sweep(idleTtlSec: number): Promise<void>;
  // 起動時孤児検出
  reconcileOnBoot(): Promise<void>;
}

interface ExecResult {
  stdout: string;      // truncated
  stderr: string;      // truncated
  exitCode: number;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
  files: Array<{ name: string; bytes: Uint8Array; mime: string }>;
}
```

### Discord 出力整形ルール

1. 短文（stdout + stderr 合計 1500 字以下、画像なし）:
   - コードブロック埋め込み 1 件で返信。
2. 長文 or バイナリ:
   - Embed: exit code / duration / truncation 表示
   - Attachment: `stdout.txt`, `stderr.txt`（空でなければ）, 画像は `image_<n>.png` として image embed
3. 例外（タイムアウト / OOM / sandbox 起動失敗）:
   - Embed の color を赤、エラー種別を見出しに

### /run スラッシュコマンド + Modal フロー

```text
1. /run language:python  ← slash command (language は choices)
2. Bot: Modal を showModal() で開く
   ModalBuilder
     ├ TextInputBuilder (paragraph, label="Code", maxLength=4000)
     └ TextInputBuilder (short, label="Timeout sec (optional)", required=false)
3. ユーザ submit
4. interactionCreate handler が ModalSubmitInteraction を捕捉
5. defer → sandboxService.execute() → 整形して reply
```

Discord UI の制約と採用判断:

- **Modal**: text input のみ、最大 5 components、`maxLength=4000`。コード入力に十分。Modal は slash/button/select の応答としてしか開けない（自動表示不可）が、本ケースは `/run` の応答として開くので問題なし。
- **Slash command string option**: 1 行入力、改行は `\n` 手入力になり UX 悪い。却下。
- **メッセージ添付 (.py / .js)**: スレッド内で会話文の流れを切らずに送れるが、コマンド意図が暗黙的になり誤反応リスク。v1 は採用せず、将来 `/run upload` サブコマンドとして拡張余地。
- **コードブロックを含むメッセージ自動検知**: 同上、意図検知が曖昧で却下。

### tool calling 多ターンループ

`chatService` の擬似コード:

```ts
let messages = [...history, userMessage];
for (let turn = 0; turn < MAX_TURNS; turn++) {
  const res = await openrouter.chat({ model, messages, tools });
  const msg = res.choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) return msg.content;
  for (const call of msg.tool_calls) {
    const result = await toolHandler.dispatch(call, ctx);
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}
throw new MaxToolTurnsExceededError();
```

`MAX_TURNS = 5` で暴走防止。`ctx` は `{ channelId, guildId, userId }`。

### 環境変数

| 名前 | デフォルト | 用途 |
| ---- | ---------- | ---- |
| `SANDBOX_ENABLED` | `false` | 機能全体の kill switch |
| `SANDBOX_MAX_CONCURRENT` | `4` | 同時起動上限 |
| `SANDBOX_IDLE_TTL_SEC` | `600` | アイドル TTL |
| `SANDBOX_DEFAULT_CPUS` | `1` | per-sandbox |
| `SANDBOX_DEFAULT_MEMORY_MIB` | `512` | per-sandbox |
| `SANDBOX_NETWORK_ALLOWLIST` | `pypi.org,files.pythonhosted.org,registry.npmjs.org` | `with_network` ツールで使用 |
| `MSB_HOME` | `~/.microsandbox` | NAPI が参照 |

### セキュリティ・観測

- 既存の `metrics.ts`（admin-endpoints で導入予定）に `sandbox_started_total` / `sandbox_failed_total` / `sandbox_active` / `code_exec_duration_ms` を追加。
- ログ: 実行 1 件ごとに `{ channelId, lang, code_hash, exit, duration_ms, network }` を info で出力。コード本体は **ログしない**（プライバシー / トークン削減）。
- `code_execution_enabled = 0` の guild で tool call が来たら、`tool` メッセージで「無効化されています」を返し LLM に丁寧に断らせる。

### 参照

- microsandbox README & docs: <https://github.com/superradcompany/microsandbox>
  - `sdk/node-ts/README.md` — NAPI SDK 概要、detached mode
  - `docs/networking/security-model.mdx` — default-deny egress 仕様
  - `docs/configuration.mdx` — `sandbox_defaults` / paths
  - `scripts/install.sh:379-390` — glibc 要件
- OpenRouter tool calling: <https://openrouter.ai/docs/guides/features/tool-calling>
- OpenRouter models filter: `GET /api/v1/models?supported_parameters=tools`
- discord.js Modal: <https://discordjs.guide/interactions/modals.html>

## Tasks

### Phase 0: ホスト検証（実装着手の前提条件）

- [ ] Proxmox LXC conf に `/dev/kvm` パススルー + `nesting=1` 設定
- [ ] Coolify Bot コンテナのベースを `oven/bun:1-debian` に変更し起動確認
- [ ] Bot コンテナ内で `ls -l /dev/kvm` と `npx microsandbox run debian -- echo hi` が成功することを確認
- [ ] 失敗時の判定: Phase A 中止 → Phase B（別 Proxmox VM + HTTP wrapper）に切替方針を再起票

### Phase A: sandbox 基盤

- [ ] `microsandbox` を依存追加、`~/.microsandbox` を named volume 化
- [ ] DB マイグレーション: `sandbox_sessions` + `code_execution_enabled`
- [ ] `sandboxService` 実装（getOrCreate / execute / stop / sweep / reconcileOnBoot）
- [ ] LRU + TTL sweeper を `setInterval` で 5 分毎起動
- [ ] 環境変数追加 + `envVars.ts` 反映
- [ ] unit test: sandboxService（Sandbox を mock 化）

### Phase B: ユーザ UI

- [ ] `/run` スラッシュコマンド実装（language choices）
- [ ] Modal builder + ModalSubmitInteraction handler
- [ ] `codeExecutionService` 実装（出力整形 + 添付ファイル化 + 画像ピックアップ）
- [ ] `/config code-execution <on|off>` サブコマンド
- [ ] `/status` に sandbox 機能状態を表示

### Phase C: LLM tool 統合

- [ ] `src/llm/tools/index.ts` で `execute_code` / `execute_code_with_network` 定義
- [ ] `openrouter.ts` で `tools` / `tool_choice` を送出
- [ ] `toolHandler` の dispatch ロジック
- [ ] `chatService` の多ターンループ（MAX_TURNS=5）
- [ ] tool 結果メッセージのフォーマット
- [ ] guild で機能無効時の degrade 動作

### Phase D: 観測 + 仕上げ

- [ ] metrics: `sandbox_started_total` / `sandbox_active` / `code_exec_duration_ms`
- [ ] ログフィールド: channelId / lang / code_hash / exit / duration / network
- [ ] integration test（`KVM_AVAILABLE=1` で実 sandbox 1 回起動）
- [ ] README の AUTO セクション再生成（コマンド一覧 / 環境変数）
- [ ] docs/changes/code-execution/ 削除（リリース完了時、git 履歴をアーカイブとする）

## Open Questions / Risks

- **LXC 内 `/dev/kvm` 配線が通らない可能性**: Phase 0 で 30 分以内に判定。失敗なら Phase B へ pivot。
- **Coolify が device pass-through を UI で許可していない場合**: compose-override か raw Docker run を要求するかもしれない。Coolify v4 系の挙動を Phase 0 で要確認。
- **`createDetached()` 後の DB 整合性**: NAPI 呼び出しの直後に Bot がクラッシュすると DB なし・sandbox ありの孤児が残る。`reconcileOnBoot()` でカバーするが、可能なら NAPI 呼び出しを DB トランザクションの内側に置く順序を検討。
- **言語追加要求**: rust / go / ruby など。OCI image 追加だけで対応可能だが、`/run language` choices と toolschema enum も併せて更新が必要。enum を DB / 設定ファイル駆動にすべきか v1 リリース後に判断。
- **`execute_code_with_network` の allow-list 維持コスト**: pypi mirror の host 変更などで壊れる可能性。環境変数で吸収する形にしているが、運用上 dashboard 化したくなる可能性あり。
- **モデル側の tool calling 安定性**: DeepSeek V4 Flash:free / Gemini Flash 系 / Claude Haiku 4.5 で問題が出たケースを観測したら、モデル選定 UI 側の絞り込み（別 spec）を優先する。

## Out of Scope（別 spec を切る候補）

- **モデル選定 UI の tool calling 絞り込み**: `GET /api/v1/models?supported_parameters=tools` の結果で `/model` choices を動的にフィルタする。新 change `model-selection-tool-filter` として独立。`code-execution` のリリース後に着手で良い（先にユーザが tool 非対応モデルでハマる事例を観測してから優先度判断）。
- **デフォルトモデル更新（`deepseek/deepseek-r1-0528:free` → `deepseek/deepseek-v4-flash:free`）**: spec 不要の単一定数変更。`envVars.ts` の `DEFAULT_MODEL` を差し替えて単独 PR を切る。
