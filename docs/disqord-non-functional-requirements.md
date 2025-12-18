# DisQord 非機能要件定義書

## 概要

本ドキュメントでは、DisQordの技術スタック、デプロイ方式、運用に関する非機能要件を定義する。

---

## 1. 技術スタック

| 項目 | 選定 | 備考 |
|------|------|------|
| 言語 | TypeScript | 型安全性を重視 |
| Discordライブラリ | [discord.js](https://discord.js.org/docs/) | Node.js向け公式推奨ライブラリ |
| ランタイム | [Bun](https://bun.com/docs/llms.txt) | 高速なTypeScriptランタイム |
| ツール/タスク | [mise](https://mise.jdx.dev/getting-started.html) + [Biome](https://biomejs.dev/guides/getting-started/) | Bun 1.3.x固定とタスク実行統一、BiomeでLint/Format |
| データ永続化 | SQLite | 軽量、ファイルベース |

---

## 2. デプロイ・ホスティング

### 2.1 ホスティング環境

| 項目 | 内容 |
|------|------|
| プラットフォーム | [Coolify](https://coolify.io/docs/llms.txt) |
| ホスト | 自宅サーバー |
| ビルド方式 | Dockerfile |
| 自動デプロイ | あり（GitHub連携） |

### 2.2 リポジトリ

| 項目 | 内容 |
|------|------|
| ホスティング | GitHub |
| 公開設定 | Public |
| バージョン管理 | GitHub Releases |

### 2.3 環境構成

| 環境 | ブランチ | 用途 | 実行場所 |
|------|----------|------|----------|
| Production | main | 本番（開発チーム向けリリース） | Coolify（自動デプロイ） |
| Development | develop | 開発・動作確認 | ローカル（手動起動） |

### 2.4 環境分離

以下のリソースは環境ごとに分離する。

| リソース | Production | Development |
|----------|------------|-------------|
| Discord Bot | 本番用Bot | 開発用Bot（開発者ごとに作成） |
| 実行環境 | Coolify | ローカル（`bun dev`） |
| 環境変数 | Coolifyで管理 | `.env`ファイル |
| SQLiteファイル | Dockerボリューム | `data/disqord.db` |

---

## 3. データ永続化

### 3.1 SQLite

| 項目 | 内容 |
|------|------|
| 格納場所 | Dockerボリューム（永続化） |
| バックアップ | v1では手動（将来自動化検討） |

### 3.2 ボリュームマウント

Dockerコンテナ再起動時にデータが消失しないよう、SQLiteファイルはボリュームマウントで永続化する。

```text
/app/data/disqord.db → Coolifyマネージドボリューム
```

---

## 4. 環境変数

### 4.1 管理方法

Coolifyの環境変数機能で管理する。

### 4.2 必要な環境変数

| 変数名 | 説明 | 必須 |
|--------|------|------|
| DISCORD_TOKEN | Discord Bot Token | Yes |
| DISCORD_APPLICATION_ID | Discord Application ID | Yes |
| OPENROUTER_API_KEY | OpenRouter API Key | Yes |
| NODE_ENV | 環境識別（production / development） | No（デフォルト: development） |
| DATABASE_PATH | SQLiteファイルパス | No（デフォルト: data/disqord.db） |
| DEFAULT_MODEL | デフォルトLLMモデル | No（デフォルト: deepseek/deepseek-r1-0528:free） |

### 4.3 将来追加予定

| 変数名 | 説明 | 用途 |
|--------|------|------|
| GITHUB_TOKEN | GitHub API Token | リリースノート配信機能 |

---

## 5. ログ管理

| 項目 | 内容 |
|------|------|
| 出力先 | コンソール（stdout） |
| 確認方法 | Coolifyダッシュボード |
| ログレベル | INFO, WARN, ERROR |
| 外部連携 | なし（v1） |

---

## 6. CI/CD

| 項目 | 内容 |
|------|------|
| CI | なし（v1） |
| CD | GitHub Actions → Coolify Webhook |
| 初回セットアップ | `mise run setup` |
| 開発コマンド | `bun dev` `bun start` `bun test` `bun typecheck` `bun lint` `bun format` |

### 6.1 自動デプロイ

GitHub Releaseを作成すると、GitHub ActionsがCoolify Webhookをトリガーし自動デプロイが実行される。

| 項目 | 内容 |
|------|------|
| ワークフロー | `.github/workflows/deploy.yml` |
| トリガー | `release: [published]` |
| 必要なシークレット | `COOLIFY_TOKEN`, `COOLIFY_WEBHOOK` |

### 6.2 将来検討事項

- Lint / Format チェック（Biome等）
- テスト実行
- ビルド確認

---

## 7. セキュリティ

### 7.1 シークレット管理

- API KeyやTokenはCoolifyの環境変数で管理
- リポジトリにシークレットをコミットしない
- `.env`ファイルは`.gitignore`に追加

### 7.2 アクセス制御

- Botは招待されたGuildでのみ動作
- DMでの利用は不可

### 7.3 コンテナセキュリティ

- Dockerコンテナはnon-rootユーザー（`bun`）で実行
- 本番用依存関係のみインストール（`--production`フラグ）
- `.dockerignore`でビルドコンテキストから不要ファイルを除外

---

## 8. 監視・アラート

| 項目 | 内容 |
|------|------|
| 死活監視 | Coolifyのヘルスチェック |
| エラー通知 | なし（v1） |

### 8.1 将来検討事項

- Discordへのエラー通知（管理者向けチャンネル）
- 外部監視サービス連携

---

## 更新履歴

| 日付 | バージョン | 内容 |
|------|------------|------|
| 2025-11-26 | 1.0 | 初版作成 |
| 2025-12-11 | 1.1 | デプロイ方針変更（developブランチはローカル開発用に）、DISCORD_APPLICATION_ID追加 |
| 2025-12-16 | 1.2 | コンテナセキュリティ要件を追加（non-rootユーザー実行、.dockerignore） |
| 2025-12-18 | 1.3 | DEFAULT_MODEL環境変数を追加 |
| 2025-12-19 | 1.4 | GitHub Actions自動デプロイ（Release→Coolify）を追加、v1.0.0リリース |
