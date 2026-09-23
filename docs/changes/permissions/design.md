---
title: "権限管理"
status: planned
priority: medium
summary: "チャンネル制限と、設定変更の共通認可契約（admin_role_id）"
---

# 権限管理

## Why

Bot が全チャンネル・全ユーザに無制限でアクセス可能な状態は、大規模サーバーでの運用に適さない。
チャンネル単位の制限が必要である。

加えて、課金が絡む `/config` サブコマンドを誰が実行できるかの契約が無い。
契約が無いため、[Web 検索 + ツイート展開](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) と [スケジュール実行（cron）](../cron/design.md) は、どちらも「権限機構が未実装なら暫定的に handler 内で `ManageGuild` を確認する」という同じ暫定措置を design に書いている。
本 change で共通の認可契約を先に確定し、この重複を無くす。

## 依存 / 関連 change

- 関連: [使用統計](../usage-stats/design.md) — 同じ `guild_settings` を触るが、リリース単位としては独立。本 change は権限だけを扱う
- 後続: [Web 検索 + ツイート展開](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) / [スケジュール実行（cron）](../cron/design.md) — 本 change の認可契約を使う。未成立の場合の暫定措置が各 design に書かれている
- 関連: [Discord 操作ツール](../discord-tool/design.md) — 独自の認可設計（bot 権限と invoking member 権限の積）を持つ。本 change の `admin_role_id` に置き換えない
- 関連: [回答の再生成・編集/undo・compaction](../conversation-regeneration/design.md) — 操作認可は「発話者本人または `ManageMessages`」であり、本 change の設定変更権限とは別軸

## Goals / Non-Goals

**Goals:**

- Bot 利用を特定チャンネルに制限可能にする
- 設定変更の認可を 1 箇所の共通関数で表現し、後続 change が各自で暫定実装を書かなくて済むようにする
- `admin_role_id` 未設定時の既定動作を確定する

**Non-Goals:**

- 使用統計（[使用統計](../usage-stats/design.md)）
- ユーザーごとの使用量制限（レートリミット）
- ロール単位の機能設定（[設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) の scope とは別軸）
- `/model` など課金に直結しないコマンドの権限変更

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 権限のデフォルト | 全チャンネル許可 | 既存動作を維持、明示的に制限する方式 |
| `admin_role_id` 未設定時 | `ManageGuild` 権限を持つメンバーを許可 | 後続 change が書いている暫定措置と同じ挙動を既定にすれば、設定しないギルドで挙動が変わらない |
| 認可の表現 | 共通関数 1 つに集約し、各 handler はそれを呼ぶ | 暫定実装の重複と、剥がし忘れを防ぐ |
| `setDefaultMemberPermissions` | 使わない | `/config` コマンド全体に作用して既存サブコマンドの挙動も変わる。サブコマンド単位で絞るため handler 内チェックを用いる |

## Design

### 変更対象ファイル

- 修正: `src/db/schema.ts` — `guild_settings` 拡張
- 修正: `src/db/repositories/guildSettings.ts` / `src/types/index.ts`（`GuildSettings`）— フィールド追加
- 修正: `src/services/settingsService.ts` — setter 追加
- 新規: 共通認可関数（設定変更が可能かを判定する。置き場所は実装時に確定）
- 修正: `src/bot/events/messageCreate.ts` — チャンネル制限のチェック追加
- 修正: `src/bot/commands/config.ts` / `src/bot/commands/handlers.ts` — 設定サブコマンド追加

### DB スキーマ変更

```sql
ALTER TABLE guild_settings ADD COLUMN allowed_channels TEXT;  -- JSON array
ALTER TABLE guild_settings ADD COLUMN admin_role_id TEXT;
```

### 設計メモ

- `allowed_channels`: NULL = 全チャンネル許可、配列 = 指定チャンネルのみ
- `admin_role_id`: 設定変更権限を持つロール。NULL のときは `ManageGuild` を持つメンバーを許可する
- 認可の判定は共通関数 1 つに閉じ込め、後続 change の handler はその関数だけを呼ぶ。各 change が `member.permissions.has(ManageGuild)` を直接書かない

**参照**:

- [discord.js PermissionsBitField](https://discord.js.org/docs/packages/discord.js/14.26.3/PermissionsBitField:Class) - `member.permissions.has()`で権限チェック
- [discord.js GuildMember](https://discord.js.org/docs/packages/discord.js/14.26.3/GuildMember:Class) - `member.roles.cache.has(roleId)`でロール所属確認

## Tasks

- [ ] `guild_settings` に `allowed_channels` / `admin_role_id` カラム追加（schema / types / repository / upsert）
- [ ] `settingsService` に setter 追加
- [ ] 共通認可関数を実装（`admin_role_id` 未設定時は `ManageGuild` にフォールバック）
- [ ] `messageCreate` にチャンネル制限チェック追加
- [ ] 権限設定コマンド + ハンドラ実装
- [ ] テスト追加（チャンネル制限・`admin_role_id` 設定時と未設定時の認可）
- [ ] `docs/changes/permissions/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **共通認可関数の置き場所**: `settingsService` のメソッドにするか、独立したユーティリティにするか。`discord-tool` が持つ「bot 権限と member 権限の積」という別軸の認可と混ざらない形にする
