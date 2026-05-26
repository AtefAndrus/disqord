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
| Discord 出力整形 | Components V2 (`Container` + `TextDisplay` + `MediaGallery` + `File` + `Section`/`Button`) で 1 メッセージ完結 | 2025-04 リリースの新コンポーネント体系。embed の 4096 字制限を `TextDisplay` 複数化で吸収、画像は `MediaGallery` で並列表示、長文 stdout は `File` で attachment card 化、`Section` の accessory に再実行 `Button` を置ける。1 メッセージあたり 40 components 枠 |
| 画像出力ピックアップ | sandbox 終了後 `/tmp/out/*.{png,jpg,jpeg,svg}` を自動収集 | matplotlib / Pillow 等の慣習的な出力場所を強制せず、ユーザに「`/tmp/out/` に保存して」と暗黙ルールを置く |
| ユーザ UI（v1 リリース時） | LLM tool call のみ。`/run` スラッシュコマンドはリリースしない | LLM チャット経由の利用が主目的。`/run` を出すと LLM 関係ない単独機能が増え、設計のフォーカスがぼやける |
| ユーザ UI（実装/テスト時のみ） | `/run` スラッシュコマンド → Modal 1 枚に `StringSelect(language)` + `TextInput(code, paragraph, max=4000)` を `Label` wrap で同梱 | 2025-09 から modal に select が入れられるため slash option を削れる。`NODE_ENV !== "production"` のときだけ command registration、production では未公開 |
| 言語選択 | modal 内 `StringSelect` の choices で `python` / `node` / `bash` 固定 | v1 は限定。tool 側 `language` enum と同一定義を import |
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
- `src/config/envVars.ts` — `SANDBOX_ENABLED` / `SANDBOX_MAX_CONCURRENT` / `SANDBOX_IDLE_TTL_SEC` / `SANDBOX_NETWORK_ALLOWLIST` / `SANDBOX_OUTPUT_MAX_BYTES` / `MSB_HOME`
- `src/bot/commands/config.ts` — `/config code-execution <on|off>` サブコマンド
- `src/bot/commands/index.ts` — `/run` を **dev only** で条件付き登録（`if (process.env.NODE_ENV !== "production") commandDefinitions.push(runCommand)`）
- `src/bot/events/interactionCreate.ts`（または該当 handler） — Modal submit + Re-run button (`custom_id: codeexec:rerun:*`) ハンドラ追加
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

### Discord 出力整形ルール（Components V2）

メッセージは常に `MessageFlags.IsComponentsV2` flag を立てる。`content` / `embeds` / `attachments` 配列は同時使用不可（一度 V2 として送信した message は legacy に戻せない sticky flag）。

```text
Container (accent color: green/yellow/red = success/truncated/error)
├ TextDisplay  "▶ python · 1.23s · exit 0"                ← ヘッダ行
├ Separator (small)
├ TextDisplay  "```\n<stdout, up to 3800 chars>\n```"     ← 短文時はここで完結
│   (長文時は省略 → File に回す)
├ TextDisplay  "**stderr**\n```\n<stderr, up to 1500>\n```"  ← stderr あれば
├ MediaGallery [image_1.png, image_2.png, ...]            ← /tmp/out/*.{png,jpg,jpeg,svg}
├ File [stdout.txt]                                       ← stdout が 3800 字超 or truncate あり
├ File [stderr.txt]                                       ← 同様
├ Separator (large)
└ Section
    ├ TextDisplay  "Re-run last code or stop the session"
    └ Button (accessory, Secondary, custom_id="codeexec:rerun:<sandboxName>")
```

整形ルール詳細:

1. **短文** (stdout ≤ 3800 字 かつ stderr ≤ 1500 字 かつ画像 ≤ 4 枚): すべて `TextDisplay` + `MediaGallery` でインライン表示。
2. **長文 / truncate あり**: stdout/stderr を `File` (`stdout.txt`/`stderr.txt`) として attachment card 化、`TextDisplay` には先頭 N 行のプレビュー + "... (full output attached)" を表示。
3. **画像 ≥ 5 枚**: `MediaGallery` の最大 10 枚以内に収め、超過分は `File` で zip 添付（v1.1 で対応、v1 は警告して 10 枚で打ち切り）。
4. **例外** (タイムアウト / OOM / sandbox 起動失敗): Container accent を red、`TextDisplay` にエラー種別 + 原因。
5. **File 上限**: `SANDBOX_OUTPUT_MAX_BYTES` (デフォルト 9 MB) を超える stdout は事前 truncate。guild の boost level に応じて bot 起動時に上限取得（L0=10MB / L2=50MB / L3=100MB）→ 環境変数を上書き可能。

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
5. deferReply({ flags: MessageFlags.Ephemeral })
   → sandboxService.execute()
   → Components V2 メッセージで editReply
```

Discord UI の制約と採用判断:

- **Modal in modal の select**: 2025-09-10 から `Label` で wrap すれば `StringSelect` 等を modal に入れられる（[Discord API change log](https://docs.discord.com/developers/change-log)）。これにより slash option を削れて UX 簡潔。
- **Slash command string option (旧案)**: 1 行入力、改行は `\n` 手入力。modal に統合したので不要。
- **メッセージ添付 (.py / .js)**: 意図検知が暗黙的でコマンド誤反応リスク、却下。
- **コードブロックを含むメッセージ自動検知**: 同上、却下。
- **Private thread でのセッション隔離**: 検討したが v1 ではコマンド未公開のため不要。LLM tool call 経路はチャット文脈の中で結果を返すのが自然で thread 化のメリット薄。Phase 2 候補。
- **Ephemeral flag**: `ephemeral: true` は discord.js v14.19 で deprecated。`flags: MessageFlags.Ephemeral` を使う。本機能の出力は会話履歴に残したいので **ephemeral は使わない**（dev `/run` 時のみ初期 defer に使用）。

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
| `SANDBOX_OUTPUT_MAX_BYTES` | `9437184` (9 MB) | File attachment 上限。free guild の 10 MB から安全マージンを引いた値。boost L2 環境では `47185920` (45 MB) 等に上書き |
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
- Discord Components V2 (2025-04-22 リリース): <https://docs.discord.com/developers/components/reference>
- discord.js PR #10781 (Components V2 in v14): <https://github.com/discordjs/discord.js/pull/10781>
- discord.js PR #11169 (Modal Label + select-in-modal, 2025-09): <https://github.com/discordjs/discord.js/pull/11169>
- Discord Developer Change Log: <https://docs.discord.com/developers/change-log>

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

### Phase B: 出力整形 + dev/test UI

- [ ] `codeExecutionService` 実装（Components V2 ビルダ + 出力 truncation + 画像ピックアップ + `File`/`MediaGallery` 振り分け）
- [ ] Re-run button handler (`custom_id: codeexec:rerun:*`)
- [ ] `/config code-execution <on|off>` サブコマンド
- [ ] `/run` スラッシュコマンド（**dev only registration**、Modal 内 `StringSelect(language)` + `TextInput(code)` + `TextInput(timeout)` を `Label` wrap）
- [ ] ModalSubmitInteraction handler
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
- **Components V2 message が sticky な点**: 一度 V2 として送信した message は legacy に戻せない。本機能の出力は最初から V2 で組むため問題にならないが、将来 stream 編集パターンを採用する場合（マルチモーダル change と統合する場合）に注意。

## Out of Scope（別 spec を切る候補）

- **モデル選定 UI の tool calling 絞り込み**: `GET /api/v1/models?supported_parameters=tools` の結果で `/model` choices を動的にフィルタする。新 change `model-selection-tool-filter` として独立。`code-execution` のリリース後に着手で良い（先にユーザが tool 非対応モデルでハマる事例を観測してから優先度判断）。
- **LLM チャット返信の Components V2 化**: 既存 `embedBuilder.ts` ベースの 1 embed (4096 字制限) を `Container` + 複数 `TextDisplay` + 末尾 `Section` で `regenerate` / `model-switch` button を inline 配置する形へ刷新。マルチモーダル change と coupling が高いため、新 change `chat-response-v2` として独立、マルチモーダル後に着手。
- **`/run` の production 公開**: 現状 dev only。需要が出たら別 PR で `NODE_ENV` ガード解除。
- **設定 SSOT 化**: 別 change `default-model-ssot` で対応（envVars.ts を SSOT 化 + CLAUDE.md AUTO 生成）。
