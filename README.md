# DisQord

## 概要

- Discord上でOpenRouter経由のLLMと対話するBot。メンションで呼び出す単発応答型。
- デフォルトモデルは `x-ai/grok-4.1-fast:free`（Guild単位で変更可）。
- Bun + discord.js + SQLite による軽量構成。

## 主な機能 (v1)

- 呼び出し: ギルド内メンションに対応。DMは非対応。会話履歴は保持せず毎回リセット。
- コマンド: `/disqord help` `/disqord model` `/disqord model set <model>` `/disqord models` `/disqord status`
- 応答: 2000文字超は分割送信。エラー時は種別を明示（レート制限、モデル、接続など）。
- レート制限: OpenRouterの429レスポンスに含まれる `X-RateLimit-*` を確認し、Reset時刻まで送信を抑制。

## 技術スタック・運用

- 言語/ランタイム: TypeScript + Bun
- Discordライブラリ: discord.js
- DB: SQLite（`data/disqord.db`。コンテナではボリューム永続化を想定）
- ホスティング: DockerfileをCoolifyでデプロイ（mainブランチのみ）。developブランチはローカル開発用。

## 開発環境構築手順

1. 開発環境セットアップ `mise run setup`
2. 起動: `mise run dev`（本番相当は `mise run start`）
3. 型チェック: `mise run typecheck`
4. テスト: `mise run test`
5. Lint/整形: `mise run lint` / `mise run format`

### 必須環境変数

- DISCORD_TOKEN: Discord Bot Token
- DISCORD_APPLICATION_ID: アプリケーションID
- OPENROUTER_API_KEY: OpenRouter API Key
- NODE_ENV: production / development
- DATABASE_PATH: SQLiteパス（未設定時は `data/disqord.db`）

## ディレクトリ

- `src/` Bot本体（client, events, commands, services, llm, db, config, utils, types）
- `tests/` bun:test 用のユニット・統合テスト
- `docs/` 機能・非機能要件および設計書
- `data/` SQLiteファイル（gitignore済み）
- `tmp/` 補助スクリプト

## 現状

- 設計・基盤実装は完了。Bot Layer（イベントハンドラ、コマンド登録）とLLM Layer（OpenRouterクライアント）が未実装。
- 完了: config, db, services, utils, types
- 未完了: bot/events実装、bot/client配線、llm/openrouter実装、テスト
