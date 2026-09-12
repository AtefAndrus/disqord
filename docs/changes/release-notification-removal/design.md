---
title: "GitHub Release 通知機能の削除"
status: implemented
priority: medium
summary: "Discord への GitHub Release 通知とそのための Webhook、設定、永続化項目をアプリケーションから削除"
---

# GitHub Release 通知機能の削除

## Why

DisQord の主機能は OpenRouter を使った Discord 上の LLM 対話であり、Bot 自身の GitHub Release を Discord へ通知する機能は対話機能の提供に必要ない。

通知機能のために必要な公開 Webhook、署名検証用シークレット、Discord コマンド、ギルド設定を削除し、運用と保守の対象を対話機能と管理 API に限定する。

## Goals / Non-Goals

**Goals:**

- GitHub Release の Webhook 受信、payload 解釈、Discord 配信を行う専用コードを削除する
- `/config release-channel` とステータス表示の通知先項目を削除する
- ギルド設定の型、repository、service からリリース通知用の契約を削除する
- 既存 SQLite DB の `release_channel_id` カラムは残したまま参照と更新を停止し、新規 DB には同カラムを作成しない
- `/health` と HMAC 認証付き管理 API の挙動を維持する

**Non-Goals:**

- `.github/workflows/deploy.yml` の Release トリガーとデプロイ処理の変更
- 管理 API と共有 HMAC helper の削除や仕様変更
- LLM、会話履歴、メッセージ応答の変更
- 既存 SQLite DB からの `release_channel_id` カラム削除
- Release 通知を別方式で再実装すること

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 通知機能の扱い | Webhook 方式と配信ロジックを一体で削除する | 受信方式だけを削除すると、呼び出し元のない service、payload 型、ギルド設定が残るため |
| HTTP サーバー | GitHub 専用ルートだけを削除する | `/health` と `/admin/*` は通知機能と独立した運用契約であるため |
| HMAC helper | `src/http/hmac.ts` を維持する | 管理 API の署名生成と timing-safe 比較で使用中であるため |
| 既存 DB の通知先カラム | DROP せず、SELECT と INSERT/UPDATE の列リストから外す | SQLite テーブルの破壊的な再構築を避けつつ、アプリケーションからの参照と更新を停止できるため |
| 新規 DB のスキーマ | `release_channel_id` を追加する migration を削除する | 新しいインスタンスに使用しないカラムを作成しないため |
| ドキュメント | 管理 API に必要な Coolify と Cloudflare Tunnel の手順を `docs/admin-api.md` へ移し、Release 通知専用の Webhook 手順と通知方式を削除する | 通知機能に依存しない運用手順を維持しつつ、実行不能な設定と未実装の通知計画を現行仕様から外すため |

## Design

### 変更対象ファイル

**新規:**

- `docs/changes/release-notification-removal/design.md` — 通知機能の削除範囲、DB 互換性、維持する HTTP 契約を記録する

**修正:**

- `src/bot/commands/config.ts` と `src/bot/events/interactionCreate.ts` — 通知先サブコマンドの定義と dispatch を削除する
- `src/bot/commands/handlers.ts` と `src/utils/statusMessage.ts` — 通知先の操作と表示を削除する
- `src/types/index.ts`、`src/db/repositories/guildSettings.ts`、`src/services/settingsService.ts` — `GuildSettings` から通知先を削除し、repository と service の入出力契約を合わせる
- `src/db/schema.ts` — 新規 DB への通知先カラム追加を停止する
- `src/config/envVars.ts` と `src/config/index.ts` — `GITHUB_WEBHOOK_SECRET` の定義と読み込みを削除する
- `src/health.ts` と `src/index.ts` — `/webhook/github` と通知 service の DI を削除する
- `tests/helpers/mockFactories.ts` と関連テスト — 削除した契約を fixture から外し、新旧 DB スキーマの挙動を検証する
- `src/config/envVars.ts` と `src/bot/commands/config.ts` を生成元とする README と `.env.example` — 削除した環境変数とコマンドを一覧から外す
- `docs/admin-api.md` — Coolify のポート公開と Cloudflare Tunnel の構築手順を管理 API の本番設定へ移す
- `AGENTS.md` — Release 通知 Webhook を前提とするリリース説明を削除する

**削除:**

- `src/services/releaseNotificationService.ts` と対応テスト — Discord への Release 通知配信に専用のため
- `src/types/github.ts` — GitHub Release Webhook payload と通知結果に専用のため
- `src/http/webhookHandler.ts` と対応テスト — GitHub Webhook の署名ラッパと payload parser に専用のため
- `docs/infrastructure-setup.md` — 汎用インフラ手順の移動後に残る内容が GitHub Webhook と Discord 通知に専用のため
- `docs/changes/release-polling/` — 実装対象ではない Release 通知の設計のため

### DB スキーマ変更

新規 DB の `guild_settings` は `guild_id`、`default_model`、`created_at`、`updated_at`、`free_models_only`、`show_llm_details`、`auto_reply_channels` のみを持つ。

既存 DB に `release_channel_id` がある場合、migration は同カラムを削除せず、repository は明示的な列リストによって同カラムを読み書きしない。

統合テストでは、`release_channel_id` を持つ旧スキーマ相当のメモリ内 DB に migration を適用し、他のギルド設定を読み書きできることと旧カラムの値が変更されないことを確認する。

### HTTP ルート

HTTP サーバーは `GET /health`、`GET /admin/logs`、`GET /admin/metrics` を維持し、削除後の `/webhook/github` を含むその他のパスに `404 Not Found` を返す。

管理 API は `src/http/hmac.ts` の HMAC-SHA256 helper を引き続き使う。

## Tasks

- [x] Discord コマンド、handler、ステータス表示から Release 通知設定を削除
- [x] `GuildSettings`、repository、service、fixture から Release 通知用契約を削除
- [x] GitHub Webhook ルート、parser、payload 型、通知 service と対応テストを削除
- [x] GitHub Webhook 専用環境変数を削除し、README と `.env.example` を再生成
- [x] Coolify と Cloudflare Tunnel の汎用手順を管理 API 文書へ移し、Webhook 専用手順と Release 通知の方式を扱う change を削除
- [x] 新規 DB に旧カラムを作成しないことと、既存 DB で他の設定を読み書きできることを統合テストで確認
- [x] 生成、テスト、lint、Markdown lint を実行
- [ ] `docs/changes/release-notification-removal/` 削除（リリース完了時、git 履歴がアーカイブ）
